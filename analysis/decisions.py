"""Load data/decisions.jsonl and the shared classifier.json.

DecisionV2 mirrors bot/src/log.ts and should_hide() mirrors bot/src/classifier.ts;
keep them in sync. Older v1 lines are upgraded to v2 on read (see _upgrade_v1).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = ROOT / "data" / "decisions.jsonl"
DEFAULT_CLASSIFIER = ROOT / "classifier.json"

# Mirrors FailReason / HideMode in bot/src/drivers/types.ts.
FailReason = Literal[
    "not_found",
    "caret_missing",
    "menu_not_opened",
    "no_menu_item",
    "unverified",
    "wrong_post",
    "budget",
    "gave_up",
    "error",
]
HideMode = Literal["script", "auto", "agent"]


class DecisionV2(TypedDict):
    v: Literal[2]
    at: str  # ISO timestamp
    post_id: str
    author: str
    text: str
    quoted: str | None
    classifier_version: int
    model: str  # exact Jev model version that answered
    answers: dict[str, dict[str, Any]]
    hide: bool  # the classifier said hide
    acted: bool  # "Not interested" was actually clicked and verified (never on a rehearsal)
    dry_run: bool
    rehearse: bool  # menu walked, item found, Escape pressed, nothing clicked
    driver: Literal["playwright", "browser-use", "fake"]
    hide_mode: HideMode | None  # browser-use only; None for playwright
    llm: str | None  # "provider:model" when the agent could run, else None
    via: Literal["script", "agent"] | None  # which path did the hide
    fail_reason: FailReason | None
    menu_label: str | None  # menu item clicked (or that would have been, on a rehearsal)
    agent_cost_usd: float | None


def _upgrade_v1(row: dict[str, Any]) -> DecisionV2:
    """v1 lines came from the Playwright-only bot: fill in what that bot implied."""
    return cast(DecisionV2, {
        **row,
        "v": 2,
        "rehearse": False,
        "driver": "playwright",
        "hide_mode": None,
        "llm": None,
        "via": "script" if row["acted"] else None,
        "fail_reason": None,  # v1 didn't record why a hide failed
        "menu_label": None,
        "agent_cost_usd": None,
    })


def read_decisions(path: Path = DEFAULT_LOG) -> list[DecisionV2]:
    rows: list[DecisionV2] = []
    with open(path) as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("v") == 1:
                row = _upgrade_v1(row)
            elif row.get("v") != 2:
                raise ValueError(f"unsupported log version {row.get('v')!r} in {path} line {n}")
            rows.append(row)
    return rows


def to_frame(rows: list[DecisionV2]) -> pd.DataFrame:
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
