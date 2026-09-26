"""Load data/decisions.jsonl and the shared classifier.json.

DecisionV1 mirrors bot/src/log.ts and should_hide() mirrors bot/src/classifier.ts;
keep them in sync.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, TypedDict

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = ROOT / "data" / "decisions.jsonl"
DEFAULT_CLASSIFIER = ROOT / "classifier.json"


class DecisionV1(TypedDict):
    v: Literal[1]
    at: str
    post_id: str
    author: str
    text: str
    quoted: str | None
    classifier_version: int
    model: str
    answers: dict[str, dict[str, Any]]
    hide: bool
    acted: bool
    dry_run: bool


def read_decisions(path: Path = DEFAULT_LOG) -> list[DecisionV1]:
    rows: list[DecisionV1] = []
    with open(path) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                if row.get("v") != 1:
                    raise ValueError(f"unsupported log version {row.get('v')!r} in {path}")
                rows.append(row)
    return rows


def to_frame(rows: list[DecisionV1]) -> pd.DataFrame:
    """One row per decision; answers flattened to columns like `not_interested.noul`."""
    flat = []
    for r in rows:
        base = {k: v for k, v in r.items() if k != "answers"}
        for qid, answer in r["answers"].items():
            for field in ("noul", "score", "choice", "confidence"):
                if field in answer:
                    base[f"{qid}.{field}"] = answer[field]
        flat.append(base)
    df = pd.DataFrame(flat)
    if not df.empty:
        df["at"] = pd.to_datetime(df["at"])
    return df


def load_decisions(path: Path = DEFAULT_LOG) -> pd.DataFrame:
    return to_frame(read_decisions(path))


def load_classifier(path: Path = DEFAULT_CLASSIFIER) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


_OPS = {
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    "<": lambda a, b: a < b,
    "==": lambda a, b: a == b,
    "in": lambda a, b: isinstance(b, list) and a in b,
}


def _matches(cond: dict[str, Any], answers: dict[str, dict[str, Any]]) -> bool:
    actual = answers.get(cond["question"], {}).get(cond["field"])
    return actual is not None and _OPS[cond["op"]](actual, cond["value"])


def should_hide(classifier: dict[str, Any], answers: dict[str, dict[str, Any]]) -> bool:
    rule = classifier["hide_if"]
    if "any" in rule:
        return any(_matches(c, answers) for c in rule["any"])
    return all(_matches(c, answers) for c in rule["all"])
