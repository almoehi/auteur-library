"""The catalog descriptor (``index.json`` ``catalog``, schema 2): what an index holds, how its items are
shown and how they may be filtered. The query code reads everything catalog-specific from here, so a new
catalog needs a new index only, never new query code.

Standard library only: this module is inlined into the shipped ``recommend.py`` and ported to
TypeScript. The build validates the authored descriptor (``catalog.yaml``) with pydantic against these
same dataclasses; ``__post_init__`` holds the cross-field rules both paths enforce.

Items are generic: ``{id, kind, title, doc, concepts, attrs: {field: value}, media}`` with
``media = {image: ref key}`` for an ``image`` kind and ``{views: [{angle, image, depth?, focus, view?}]}``
for a ``views`` kind. A filter compares ``attrs[field]`` of the items of its kind; items of other kinds
pass, an item without the field fails.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any, Literal

MediaType = Literal["image", "views"]
FilterType = Literal["integer", "number", "boolean", "string"]
FilterOp = Literal["eq", "lte", "gte", "in"]
Scalar = bool | int | float | str
FilterValue = Scalar | list[Scalar]
Filters = dict[str, FilterValue]  # filter name -> value, validated by Catalog.check_filters

_TRUE, _FALSE = ("true", "1", "yes"), ("false", "0", "no")


@dataclass(frozen=True)
class KindSpec:
    label: str
    description: str
    media: MediaType


@dataclass(frozen=True)
class FilterSpec:
    name: str
    kind: str
    field: str
    type: FilterType
    op: FilterOp
    description: str
    min: float | None = None  # integer / number only: the allowed range of the value
    max: float | None = None

    def __post_init__(self) -> None:
        numeric = self.type in ("integer", "number")
        if self.op in ("lte", "gte") and not numeric:
            raise ValueError(f"filter {self.name}: {self.op} needs an integer or number type")
        if self.op == "in" and self.type == "boolean":
            raise ValueError(f"filter {self.name}: in on a boolean, use eq")
        if not numeric and (self.min is not None or self.max is not None):
            raise ValueError(f"filter {self.name}: min / max only apply to integer or number filters")

    def check(self, value: object) -> FilterValue:
        """``value`` when it has this filter's type (a non-empty list of it for ``in``), else ValueError."""
        if self.op != "in":
            return self._check_scalar(value)
        if not isinstance(value, list | tuple) or not value:
            raise ValueError(f"filter {self.name} takes a non-empty list of {self.type} values")
        return [self._check_scalar(v) for v in value]

    def parse(self, text: str) -> FilterValue:
        """The value of a command-line ``name=text`` (``in``: comma-separated)."""
        if self.op == "in":
            return self.check([self._parse_scalar(t.strip()) for t in text.split(",") if t.strip()])
        return self.check(self._parse_scalar(text.strip()))

    def matches(self, item: Mapping[str, Any], value: FilterValue) -> bool:
        if item["kind"] != self.kind:
            return True
        attr = item["attrs"].get(self.field)
        if attr is None:
            return False
        if self.op == "eq":
            return bool(attr == value)
        if self.op == "in":
            return attr in value  # type: ignore[operator]  # check() made it a list
        return bool(attr <= value if self.op == "lte" else attr >= value)

    def _check_scalar(self, value: object) -> Scalar:
        ok = {
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, int | float) and not isinstance(value, bool),
            "boolean": isinstance(value, bool),
            "string": isinstance(value, str),
        }[self.type]
        if not ok:
            raise ValueError(f"filter {self.name} takes {self.type} values, not {value!r}")
        assert isinstance(value, bool | int | float | str)
        if not isinstance(value, bool | str) and (
            (self.min is not None and value < self.min) or (self.max is not None and value > self.max)
        ):
            lo, hi = _num(self.min), _num(self.max)
            raise ValueError(f"filter {self.name}: {_num(value)} is outside {lo}..{hi}")
        return value

    def _parse_scalar(self, text: str) -> Scalar:
        try:
            if self.type == "integer":
                return int(text)
            if self.type == "number":
                return float(text)
        except ValueError:
            raise ValueError(f"filter {self.name} takes {self.type} values, not {text!r}") from None
        if self.type == "boolean":
            if text.lower() not in (*_TRUE, *_FALSE):
                raise ValueError(f"filter {self.name} takes true or false, not {text!r}")
            return text.lower() in _TRUE
        return text


def _num(value: float | None) -> str:
    """A number as JavaScript prints it (``3.0`` -> ``3``), so error texts match the TypeScript port."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


@dataclass(frozen=True)
class Catalog:
    key: str  # the S3 path segment: library/<key>/...
    title: str
    description: str  # one or two sentences for an agent
    nudity: bool  # some content may show nudity
    kinds: dict[str, KindSpec]  # in result order
    filters: list[FilterSpec]
    result_fields: dict[str, list[str]]  # kind -> the attrs a pick carries
    decider_context: str  # "Context of <decider_context>: <context>" in the decision-model prompt
    decider_guidance: dict[str, str]  # kind -> an extra judging hint for the decision model
    max_k: int  # the most picks per kind an agent should ask for

    def __post_init__(self) -> None:
        if not self.kinds:
            raise ValueError("a catalog needs at least one kind")
        for kind in self.kinds:
            if kind.isdigit():  # a JavaScript object would put it first, out of the declared order
                raise ValueError(f"kind {kind!r} is integer-like; kind keys must not be all digits")
        names = [f.name for f in self.filters]
        if len(set(names)) != len(names):
            raise ValueError(f"duplicate filter names: {names}")
        unknown = (
            {f.kind for f in self.filters} | set(self.result_fields) | set(self.decider_guidance)
        ) - set(self.kinds)
        if unknown:
            raise ValueError(f"unknown kinds {sorted(unknown)}; the catalog has {list(self.kinds)}")
        if self.max_k < 1:
            raise ValueError("max_k must be at least 1")

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Catalog:
        return cls(
            **{
                **data,
                "kinds": {k: KindSpec(**v) for k, v in data["kinds"].items()},
                "filters": [FilterSpec(**f) for f in data["filters"]],
            }
        )

    def to_json(self) -> dict[str, Any]:
        """The ``index.json`` form: unset optional fields (a filter's min / max) are omitted."""
        out = asdict(self)
        out["filters"] = [{k: v for k, v in f.items() if v is not None} for f in out["filters"]]
        return out

    def describe(self) -> dict[str, Any]:
        """The agent-facing summary (``recommend.py --describe``): what the catalog holds, its kinds, the
        filters an agent may set and ``max_k``. Filters omit their attr ``field``, and min / max when
        unset."""
        return {
            "catalog": self.key,
            "title": self.title,
            "description": self.description,
            "nudity": self.nudity,
            "kinds": {k: asdict(v) for k, v in self.kinds.items()},
            "filters": [
                {
                    "name": f.name,
                    "kind": f.kind,
                    "type": f.type,
                    "op": f.op,
                    **({"min": f.min} if f.min is not None else {}),
                    **({"max": f.max} if f.max is not None else {}),
                    "description": f.description,
                }
                for f in self.filters
            ],
            "max_k": self.max_k,
        }

    def default_k(self) -> int:
        """Picks per kind when the caller names no ``k``: 3, at most ``max_k``."""
        return min(3, self.max_k)

    def check_k(self, k: int | None) -> int:
        """``k`` (None: ``default_k``) when it is 1..max_k, else a ValueError."""
        if k is None:
            return self.default_k()
        if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= self.max_k:
            raise ValueError(f"k must be between 1 and {self.max_k}")
        return k

    def check_kinds(self, kinds: Sequence[str] | None) -> list[str]:
        """The requested kinds in catalog order (None: all); an unknown kind is a ValueError."""
        if kinds is None:
            return list(self.kinds)
        unknown = [k for k in kinds if k not in self.kinds]
        if unknown:
            raise ValueError(f"unknown kind {unknown[0]!r}; allowed: {', '.join(self.kinds)}")
        return [k for k in self.kinds if k in kinds]

    def check_filters(self, filters: Mapping[str, object] | None) -> list[tuple[FilterSpec, FilterValue]]:
        """The active filters with their validated values. An unknown name or a value of the wrong type
        is a ValueError that names the allowed filters / the expected type."""
        by_name = {f.name: f for f in self.filters}
        active = []
        for name, value in (filters or {}).items():
            spec = by_name.get(name)
            if spec is None:
                raise ValueError(f"unknown filter {name!r}; allowed: {', '.join(by_name) or 'none'}")
            active.append((spec, spec.check(value)))
        return active

    def parse_filter(self, assignment: str) -> tuple[str, FilterValue]:
        """``name=value`` from the command line, typed by the filter's descriptor."""
        name, sep, text = assignment.partition("=")
        spec = next((f for f in self.filters if f.name == name.strip()), None)
        if not sep or spec is None:
            allowed = ", ".join(f.name for f in self.filters) or "none"
            raise ValueError(f"filter {assignment!r} is not name=value of a known filter; allowed: {allowed}")
        return spec.name, spec.parse(text)
