"""``refs`` command line: one command per build step. Heavy imports stay inside the commands."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from refsrag.jobs import JOB_SPECS, JobName
from refsrag.settings import CATALOG_FILE, PROJECT_ROOT, get_settings, load_catalog

if TYPE_CHECKING:
    from refsrag.labels import ConceptGrouping
    from refsrag.query import Recommender

app = typer.Typer(no_args_is_help=True, add_completion=False)
CATALOG_OPT = Annotated[
    Path, typer.Option("--catalog", help="the catalog descriptor yaml", exists=True, dir_okay=False)
]
ITEMS_OPT = Annotated[
    Path | None,
    typer.Option(
        help="schema-2 items jsonl of the catalog (default: the refs builder)", exists=True, dir_okay=False
    ),
]
jobs_app = typer.Typer(no_args_is_help=True, help="Agent jobs: make batches, collect outputs.")
app.add_typer(jobs_app, name="jobs")


@app.callback()
def main(verbose: Annotated[bool, typer.Option("--verbose", "-v")] = False) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, format="%(asctime)s %(message)s")


def _echo(obj: object) -> None:
    typer.echo(json.dumps(obj, indent=1, default=str))


@app.command()
def catalog() -> None:
    """Counts of the library catalog (English-only items)."""
    from refsrag.catalog import library_files, load_outfits, load_poses

    root = get_settings().require_library_root()
    outfits, poses = load_outfits(root), load_poses(root)
    _echo(
        {"outfits": len(outfits), "poses": len(poses), "files": sum(1 for _ in library_files(outfits, poses))}
    )


@app.command("upload-assets")
def upload_assets(
    dry_run: Annotated[bool, typer.Option(help="only report what would be uploaded")] = False,
    workers: Annotated[int, typer.Option(min=1, max=64)] = 16,
    catalog_file: CATALOG_OPT = CATALOG_FILE,
    items: ITEMS_OPT = None,
    root: Annotated[
        Path | None, typer.Option(help="folder of the files the items refer to (default: REFS_LIBRARY_ROOT)")
    ] = None,
) -> None:
    """Publish a catalog's files to library/<catalog>/assets/ (skips unchanged files by sha256): the
    files the --items media refer to, else the refs library's."""
    from refsrag.assets import item_library_paths
    from refsrag.assets import upload_assets as run
    from refsrag.index_build import check_items, read_items

    settings, catalog = get_settings(), load_catalog(catalog_file)
    paths = None
    if items is not None:
        rows = read_items(items)
        check_items(catalog, rows)
        paths = item_library_paths(catalog.key, rows)
    report = run(settings, catalog.key, dry_run=dry_run, workers=workers, root=root, paths=paths)
    _echo(asdict(report))


@app.command("export-lake")
def export_lake(
    out_dir: Annotated[Path, typer.Option(help="snapshot folder (not committed)")] = PROJECT_ROOT
    / "data"
    / "lake",
) -> None:
    """Read-only snapshot of the iWantClips clips and categories from the content lake."""
    from refsrag.lake import export_lake as run

    _echo(asdict(run(get_settings(), out_dir)))


@jobs_app.command("make")
def jobs_make(job: JobName) -> None:
    """Write the batch files of a job for every item without a valid result."""
    from refsrag.jobs import make_batches
    from refsrag.prepare import job_items

    paths = make_batches(job, job_items(get_settings(), job))
    _echo({"job": job, "batches": len(paths), "batch_size": JOB_SPECS[job].batch_size})


@jobs_app.command("collect")
def jobs_collect(job: JobName) -> None:
    """Validate agent outputs; merge valid batches into results.jsonl; list batches to re-run."""
    from refsrag.jobs import collect

    _echo(asdict(collect(job)))


lexicon_app = typer.Typer(no_args_is_help=True, help="Mine the concept lexicon from the lake snapshot.")
app.add_typer(lexicon_app, name="lexicon")
LAKE_DIR = PROJECT_ROOT / "data" / "lake"


def _grouping() -> ConceptGrouping:
    from refsrag.jobs import load_results
    from refsrag.labels import ConceptGrouping

    record = load_results("lexicon_concepts").get("concepts")
    if not isinstance(record, ConceptGrouping):
        raise typer.BadParameter(
            "no collected lexicon_concepts result: run `refs lexicon concepts` + its agent first"
        )
    return record


@lexicon_app.command("concepts")
def lexicon_concepts() -> None:
    """Write the lexicon_concepts batch: the category pool to group into concepts."""
    from refsrag.jobs import make_batches
    from refsrag.mine_lexicon import category_pool, concept_items, read_clips

    categories = json.loads((LAKE_DIR / "categories.json").read_text())
    pool = category_pool(categories, read_clips(LAKE_DIR / "clips.jsonl"))
    _echo(
        {
            "categories": len(pool),
            "batches": [str(p) for p in make_batches("lexicon_concepts", concept_items(pool))],
        }
    )


@lexicon_app.command("aliases")
def lexicon_aliases(
    top_k: Annotated[int, typer.Option(min=5)] = 40,
    round_no: Annotated[
        int, typer.Option("--round", min=1, help="mining round; each round's picks are kept")
    ] = 1,
    only: Annotated[list[str] | None, typer.Option(help="only these concepts (e.g. the weak ones)")] = None,
) -> None:
    """Mine alias candidates per concept and write the alias_filter batches."""
    from refsrag.jobs import make_batches
    from refsrag.mine_lexicon import alias_candidates, alias_items, concept_categories_of, read_clips

    grouping = _grouping()
    cats = concept_categories_of(grouping)
    if only:
        cats = {k: v for k, v in cats.items() if k in set(only)}
    candidates = alias_candidates(cats, read_clips(LAKE_DIR / "clips.jsonl"), top_k=top_k)
    items = alias_items(grouping, candidates, round_no=round_no)
    paths = make_batches("alias_filter", items)  # unchanged concepts keep their results (same sha)
    _echo({"concepts": len(items), "batches": len(paths)})


@lexicon_app.command("build")
def lexicon_build() -> None:
    """Assemble vocab.yaml + lexicon.json from the job results and validate on held-out clips."""
    from refsrag.jobs import load_results
    from refsrag.labels import AliasSelection
    from refsrag.mine_lexicon import (
        build_lexicon,
        concept_categories_of,
        merge_selections,
        read_clips,
        validate,
        write_outputs,
    )

    grouping = _grouping()
    cats = concept_categories_of(grouping)
    selected = merge_selections(
        {k: r.aliases for k, r in load_results("alias_filter").items() if isinstance(r, AliasSelection)}
    )
    lexicon = build_lexicon(cats, selected)
    report = validate(lexicon, cats, read_clips(LAKE_DIR / "clips.jsonl"))
    weak = write_outputs(grouping, lexicon, report)
    _echo(
        {
            "concepts": len(cats),
            "aliases": len(lexicon),
            "mean_recall": round(report.mean_recall(), 3),
            "weak": weak,
        }
    )


index_app = typer.Typer(no_args_is_help=True, help="Build and publish index versions.")
app.add_typer(index_app, name="index")


CASES_OPT = Annotated[
    Path | None,
    typer.Option(help="golden cases yaml: queries, filters, invalid (default: the refs cases)", exists=True),
]


@index_app.command("build")
def index_build(
    version: Annotated[str, typer.Argument(help="e.g. v1 (immutable once published)")],
    catalog_file: CATALOG_OPT = CATALOG_FILE,
    items: ITEMS_OPT = None,
    lexicon: Annotated[
        Path | None, typer.Option(help="lexicon json (default: lexicon.json for the refs builder, else none)")
    ] = None,
    vocab: Annotated[
        Path | None,
        typer.Option(help="concept vocab yaml (default: vocab.yaml for the refs builder, else none)"),
    ] = None,
    vector_set: Annotated[
        list[str] | None, typer.Option(help="only these vector sets (default: all)")
    ] = None,
    no_vectors: Annotated[
        bool, typer.Option("--no-vectors", help="no vector sets: stage 1 only, offline")
    ] = False,
    cases: CASES_OPT = None,
) -> None:
    """Build data/index/<version> of a catalog descriptor: from --items, or for refs from the labels,
    lexicon and concept affinities."""
    from refsrag.index_build import build, load_golden_cases

    out = build(
        get_settings(),
        load_catalog(catalog_file),
        version,
        items_file=items,
        lexicon_file=lexicon,
        vocab_file=vocab,
        vector_sets=[] if no_vectors else vector_set,
        cases=load_golden_cases(cases),
    )
    _echo({"built": str(out)})


@index_app.command("golden")
def index_golden(
    version: Annotated[str, typer.Argument(help="e.g. v2 (an already built index)")], cases: CASES_OPT = None
) -> None:
    """(Re)write the TypeScript parity fixtures of data/index/<version>: golden.json (stage 1) and
    selection-golden.json (whole recommendations). Copy them into video-harness with:

        gzip -9 -n -c data/index/<v>/index.json > <vh>/src/references/__tests__/fixtures/<v>/index.json.gz
        cp data/index/<v>/{golden,selection-golden}.json <vh>/src/references/__tests__/fixtures/<v>/
    """
    from refsrag.index_build import load_golden_cases, write_golden

    _echo({"written": [str(p) for p in write_golden(version, load_golden_cases(cases))]})


@index_app.command("publish")
def index_publish(version: str) -> None:
    """Upload data/index/<version> and point rag/latest.s<schema>.json at it; rag/latest.json (the
    deployed schema-1 readers' pointer) only for a schema-1 index."""
    from refsrag.index_build import publish

    _echo({"pointers": publish(get_settings(), version)})


eval_app = typer.Typer(no_args_is_help=True, help="Calibration: sample contexts, pool + grade, score.")
app.add_typer(eval_app, name="eval")
INDEX_OPT = Annotated[str, typer.Option(help="index version under data/index")]


def _recommenders(version: str, names: list[str] | None = None) -> dict[str, Recommender]:
    from refsrag.eval import VARIANTS
    from refsrag.index_build import INDEX_ROOT
    from refsrag.query import Index, Recommender

    index = Index(INDEX_ROOT / version)
    key = get_settings().featherless_api_key
    return {
        n: Recommender(index, featherless_api_key=key, **v)
        for n, v in VARIANTS.items()
        if not names or n in names
    }


@eval_app.command("sample")
def eval_sample() -> None:
    """Write eval/contexts.jsonl: held-out clips stratified by mined concept, plus the hand cases."""
    from refsrag.eval import sample_contexts, write_contexts
    from refsrag.mine_lexicon import concept_categories_of, read_clips

    contexts = sample_contexts(read_clips(LAKE_DIR / "clips.jsonl"), concept_categories_of(_grouping()))
    write_contexts(contexts)
    _echo({"contexts": len(contexts)})


@eval_app.command("pool")
def eval_pool(
    version: INDEX_OPT = "v1",
    extra: Annotated[bool, typer.Option(help="grade only pool members not graded yet")] = False,
    variant: Annotated[list[str] | None, typer.Option(help="only these variants")] = None,
) -> None:
    """Pool every variant's top candidates per context and write the eval_grade batches."""
    from refsrag.eval import grade_items, load_grades, read_contexts
    from refsrag.jobs import make_batches

    recs = _recommenders(version, variant)
    index = next(iter(recs.values())).index
    # results of items not passed here (e.g. the full gradings during an --extra run) are kept
    graded = load_grades({i["id"] for i in index.items}) if extra else None
    items = grade_items(index, read_contexts(), recs, graded)
    paths = make_batches("eval_grade", items)
    _echo({"batches": len(paths)})


@eval_app.command("score")
def eval_score(
    version: INDEX_OPT = "v1",
    search: bool = True,
    variant: Annotated[list[str] | None, typer.Option(help="only these variants")] = None,
) -> None:
    """nDCG@3 per variant on the graded pool; the grid search per variant is tuned on the tune half of
    the contexts and reported on the test half; writes eval/report.md."""
    from refsrag.eval import (
        GRID,
        SplitScore,
        grid,
        load_grades,
        read_contexts,
        score,
        split_contexts,
        write_report,
    )

    recs = _recommenders(version, variant)
    index = next(iter(recs.values())).index
    kind_of = {i["id"]: i["kind"] for i in index.items}
    grades = load_grades(kind_of.keys())
    tune, test = split_contexts(read_contexts())
    variant_scores = {
        n: SplitScore(score(r, tune, grades, kind_of), score(r, test, grades, kind_of))
        for n, r in recs.items()
    }
    best = {}
    if search:
        for n, r in recs.items():
            trials = [(p, score(r.with_params(p), tune, grades, kind_of)) for p in grid(r)]
            params, tuned = max(trials, key=lambda t: t[1].mean)
            best[n] = (params, SplitScore(tuned, score(r.with_params(params), test, grades, kind_of)))
    report = write_report(index.catalog, variant_scores, best, len(tune), len(test))
    _echo(
        {
            "report": str(report),
            "variants": {n: asdict(s) for n, s in variant_scores.items()},
            "best": {n: [{k: p[k] for k in GRID}, asdict(s)] for n, (p, s) in best.items()},
        }
    )
