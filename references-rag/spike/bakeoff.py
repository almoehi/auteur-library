"""P0 spike: compare stage-1 (BM25 + concept lexicon), dense (bge-small) and cross-encoder rerankers
on the 30 spike-labelled items with hand-graded queries. Prints nDCG@3 per method and kind."""
import json, math, re, sys, time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

SPIKE = Path("/Users/hannes/work/auteur-library/references-rag/spike")
VOCAB = yaml.safe_load((SPIKE / "vocab_v0.yaml").read_text())
ALIASES = VOCAB["concepts"]


def concept_text(concepts, min_w=0.5):
    out = []
    for c, w in concepts.items():
        if w >= min_w:
            out += [c.replace("_", " ")] + ALIASES.get(c, [])[:4]
    return out


def outfit_doc(o):
    arch = [a.replace("_", " ") for a, w in o["archetypes"].items() if w >= 0.4]
    return ". ".join([o["description_en"], "Garments: " + ", ".join(o["garments"]),
                      "Style: " + ", ".join(arch), "Footwear: " + o["footwear"],
                      "Used for: " + ", ".join(concept_text(o["concepts"]))])


def pose_doc(p):
    focus = {}
    for a in p["angles"].values():
        for f, w in a["focus"].items():
            focus[f] = max(focus.get(f, 0), w)
    shows = [f.replace("_", " ") for f, w in focus.items() if w >= 0.6]
    return ". ".join([p["name_en"], p["description_en"], "Support: " + p["support"],
                      "Shows off: " + ", ".join(shows),
                      "Positions: " + ", ".join(p.get("sex_positions", [])),
                      "Used for: " + ", ".join(concept_text(p["concepts"]))])


items = []
for f in ["outfits_a.json", "outfits_b.json"]:
    for o in json.load(open(SPIKE / "labels" / f)):
        items.append(dict(id=o["id"], kind="outfit", doc=outfit_doc(o), concepts=o["concepts"]))
for f in ["poses_a.json", "poses_b.json"]:
    for p in json.load(open(SPIKE / "labels" / f)):
        items.append(dict(id=p["id"], kind="pose", doc=pose_doc(p), concepts=p["concepts"]))

TOK = re.compile(r"[a-z0-9]+")
tok = lambda s: TOK.findall(s.lower())


def concept_query(q):
    ql = " " + " ".join(tok(q)) + " "
    return {c: 1.0 for c, al in ALIASES.items()
            if any(f" {' '.join(tok(a))} " in ql for a in al + [c.replace("_", " ")])}


def bm25_scores(q, docs, k1=1.2, b=0.75):
    toks = [tok(d) for d in docs]
    N, avg = len(docs), sum(map(len, toks)) / len(docs)
    df = {}
    for t in toks:
        for w in set(t):
            df[w] = df.get(w, 0) + 1
    out = []
    for t in toks:
        s = 0.0
        for w in set(tok(q)):
            tf = t.count(w)
            if tf:
                idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(t) / avg))
        out.append(s)
    return np.array(out)


def rrf(*rankings, k=60):
    s = np.zeros(len(rankings[0]))
    for r in rankings:
        order = np.argsort(-r)
        for rank, i in enumerate(order):
            s[i] += 1 / (k + rank + 1)
    return s


class Onnx:
    def __init__(self, repo):
        self.tok = Tokenizer.from_file(hf_hub_download(repo, "tokenizer.json", cache_dir="hf"))
        self.tok.enable_truncation(512)
        self.tok.enable_padding()
        self.sess = ort.InferenceSession(hf_hub_download(repo, "onnx/model_quantized.onnx", cache_dir="hf"))
        self.inputs = {i.name for i in self.sess.get_inputs()}

    def run(self, encs):
        feed = {"input_ids": np.array([e.ids for e in encs], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in encs], dtype=np.int64)}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in encs], dtype=np.int64)
        return self.sess.run(None, feed)[0], feed["attention_mask"]


class Dense(Onnx):
    def embed(self, texts):
        out, _ = self.run(self.tok.encode_batch(texts))
        v = out[:, 0]  # bge: CLS pooling
        return v / np.linalg.norm(v, axis=1, keepdims=True)


class Cross(Onnx):
    def score(self, q, docs):
        out, _ = self.run(self.tok.encode_batch([(q, d) for d in docs]))
        return out[:, 0] if out.ndim == 2 else out


BGE_Q = "Represent this sentence for searching relevant passages: "

QUERIES = json.load(open(SPIKE / "bakeoff_qrels.json"))


def ndcg3(ranked_ids, rel):
    dcg = sum(rel.get(i, 0) / math.log2(r + 2) for r, i in enumerate(ranked_ids[:3]))
    ideal = sorted(rel.values(), reverse=True)[:3]
    idcg = sum(g / math.log2(r + 2) for r, g in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def main():
    dense = Dense("Xenova/bge-small-en-v1.5")
    crosses = {"minilm-ce": Cross("Xenova/ms-marco-MiniLM-L-6-v2"),
               "mxbai-xsmall": Cross("mixedbread-ai/mxbai-rerank-xsmall-v1"),
               "bge-reranker-base": Cross("Xenova/bge-reranker-base")}
    results, timing = {}, {}
    for kind in ["outfit", "pose"]:
        its = [i for i in items if i["kind"] == kind]
        docs = [i["doc"] for i in its]
        dvec = dense.embed(docs)
        ccols = sorted(ALIASES)
        cmat = np.array([[i["concepts"].get(c, 0) for c in ccols] for i in its])
        for q in [q for q in QUERIES if kind in q["rel"]]:
            rel = q["rel"][kind]
            text = q["text"]
            bm = bm25_scores(text, docs)
            cq = concept_query(text)
            cs = cmat @ np.array([cq.get(c, 0) for c in ccols])
            qv = dense.embed([BGE_Q + text])[0]
            ds = dvec @ qv
            variants = {"bm25": bm, "concept": cs, "dense": ds,
                        "stage1(bm25+concept)": rrf(bm, cs), "hybrid(bm25+concept+dense)": rrf(bm, cs, ds)}
            for name, ce in crosses.items():
                t = time.time()
                sc = ce.score(text, docs)
                timing.setdefault(name, []).append((time.time() - t) / len(docs))
                variants[f"ce:{name}"] = sc
                # blend: cross-encoder rank fused with concept affinity (planned final stage)
                variants[f"hybrid+ce:{name}"] = rrf(rrf(bm, cs, ds), sc, cs)
            for name, s in variants.items():
                ranked = [its[i]["id"] for i in np.argsort(-s)]
                results.setdefault((kind, name), []).append(ndcg3(ranked, rel))
                if "--verbose" in sys.argv and name in ("stage1(bm25+concept)", "hybrid+ce:bge-reranker-base"):
                    print(f"{kind:6} {name:28} {q['text'][:50]:50} -> {ranked[:3]}  concepts={list(cq)}")
    print(f"\n{'method':34} {'outfit':>7} {'pose':>7}")
    names = sorted({n for _, n in results}, key=lambda n: list(dict.fromkeys(n for _, n in results)).index(n))
    for n in names:
        o = np.mean(results[("outfit", n)]); p = np.mean(results[("pose", n)])
        print(f"{n:34} {o:7.3f} {p:7.3f}")
    print("\nms per (query, doc) pair:", {k: round(1000 * float(np.mean(v)), 2) for k, v in timing.items()})


if __name__ == "__main__":
    main()
