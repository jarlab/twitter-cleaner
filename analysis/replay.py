"""Re-classify posts you've already seen with a (possibly edited) classifier, without opening X.

    uv run --env-file ../.env replay.py --classifier ../classifier.json --limit 100

Writes a new log (same DecisionV1 format, dry_run=True) and prints how the new
decisions differ from the original ones.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path

from typesafe_sdk import TypeSafeClient

from decisions import (
    DEFAULT_CLASSIFIER,
    DEFAULT_LOG,
    ROOT,
    DecisionV1,
    load_classifier,
    read_decisions,
    should_hide,
)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--classifier", type=Path, default=DEFAULT_CLASSIFIER)
    p.add_argument("--log", type=Path, default=DEFAULT_LOG, help="decisions to replay")
    p.add_argument("--out", type=Path, help="default: data/replay-<timestamp>.jsonl")
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--workers", type=int, default=8)
    args = p.parse_args()

    classifier = load_classifier(args.classifier)
    # Latest decision per post, most recent first.
    posts = list({r["post_id"]: r for r in read_decisions(args.log)}.values())[::-1][: args.limit]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = args.out or ROOT / "data" / f"replay-{stamp}.jsonl"
    client = TypeSafeClient(model=classifier["model"])

    def classify(original: DecisionV1) -> DecisionV1:
        res = client.system_one(
            state={"author": original["author"], "text": original["text"], "quoted_post": original["quoted"]},
            questions=classifier["questions"],
        )
        answers = {qid: a.model_dump(mode="json", exclude_none=True) for qid, a in res.answers.items()}
        return {
            **original,
            "at": datetime.now(timezone.utc).isoformat(),
            "classifier_version": classifier["version"],
            "model": res.model,
            "answers": answers,
            "hide": should_hide(classifier, answers),
            "acted": False,
            "dry_run": True,
        }

    with ThreadPoolExecutor(args.workers) as pool:
        replayed = list(pool.map(classify, posts))

    out.write_text("".join(json.dumps(r) + "\n" for r in replayed))

    flipped = [(o, n) for o, n in zip(posts, replayed) if o["hide"] != n["hide"]]
    print(f"Replayed {len(replayed)} posts -> {out}")
    print(f"Hidden before: {sum(o['hide'] for o in posts)}  after: {sum(n['hide'] for n in replayed)}")
    print(f"Changed decisions: {len(flipped)}")
    for o, n in flipped:
        arrow = "keep -> HIDE" if n["hide"] else "HIDE -> keep"
        print(f"  {arrow}  @{o['author']}: {' '.join(o['text'].split())[:70]}")


if __name__ == "__main__":
    main()
