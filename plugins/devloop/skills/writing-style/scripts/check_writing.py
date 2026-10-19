#!/usr/bin/env python3
"""Checks markdown documents against the devloop writing rules.

Rules: complete sentences (list items, prose table cells and paragraphs end with a period and
start with a capital), simple language (sentences of 25 words at most), and no em or en dashes.
Usage: check_writing.py <file.md>... ; exits 1 if there are findings.
"""
import re
import sys

MAX_WORDS = 25
DASH = re.compile("[—–]")
# Table columns that hold prose; other columns are checked only when a cell reads like prose.
PROSE_COLUMNS = {"title", "notes", "responsibility", "why", "does", "what", "problem", "change",
                 "risk", "description", "acceptance", "check", "test", "what looks unfinished",
                 "talks to (how)", "summary", "goal", "decision", "resolution"}
SKIP_FILES = ("REQUEST.md",)


def strip_code(text):
    return re.sub(r"`[^`]*`", "CODE", text)


def is_token(cell):
    """An identifier, status, number, date, name, path, ID list or link: exempt from rule 1."""
    c = strip_code(cell).strip()
    if not c or c == "CODE":
        return True
    if re.fullmatch(r"[#~]?[\w./:@+-]+(\s*,\s*[#~]?[\w./:@+-]+)*", c):
        return True
    if re.fullmatch(r"\[[^\]]+\]\([^)]+\)", c):
        return True
    return len(c.split()) < 3


def sentence_problems(text):
    """Problems with text that must be complete sentences."""
    t = strip_code(text).strip()
    t = re.sub(r"^\*\*[^*]+\*\*:?\s*", "", t)          # a bold lead-in label
    t = re.sub(r"^[A-Z]+-\d+[a-z]?:\s*", "", t)         # an ID label such as FR-1:
    t = re.sub(r"\s*\(\w+\)$", "", t) if t.endswith(")") and not t.endswith(".)") else t
    out = []
    if not t:
        return out
    if t[0].islower() and not t.startswith("CODE"):
        out.append("starts with a lowercase letter; write a complete sentence")
    if not re.search(r"[.!?:]\)?[\"']?$", t):
        out.append("doesn't end with a period; write a complete sentence, not a phrase")
    for s in re.split(r"(?<=[.!?])\s+", t):
        n = len(s.split())
        if n > MAX_WORDS:
            out.append(f"a sentence has {n} words; keep sentences to {MAX_WORDS} words or fewer")
    return out


def split_row(line):
    body = line.strip()
    body = body[1:] if body.startswith("|") else body
    body = body[:-1] if body.endswith("|") and not body.endswith("\\|") else body
    return [c.strip() for c in re.split(r"(?<!\\)\|", body)]


def check(path):
    findings = []
    lines = open(path, encoding="utf-8").read().split("\n")
    in_code = False
    columns = None
    block = []    # the current paragraph or list item: [(line number, text)]

    def flush():
        if block:
            text = " ".join(t.strip() for _, t in block)
            if not text.endswith(":"):    # a lead-in to a nested list
                for p in sentence_problems(text):
                    findings.append((block[0][0], p, text))
            block.clear()

    start = 0
    if lines and lines[0].strip() == "---":    # frontmatter
        start = next((k + 1 for k in range(1, len(lines)) if lines[k].strip() == "---"), 0)
    for i, raw in enumerate(lines[start:], start + 1):
        line = raw.rstrip("\r")
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            flush()
            in_code = not in_code
            continue
        if in_code:
            continue
        if DASH.search(re.sub(r"^\s*[-*+]\s", "", strip_code(line))):
            findings.append((i, "uses a dash between words; use a period, comma, colon or parentheses", stripped))
        if not stripped:
            flush()
            columns = None
            continue
        if stripped.startswith(("#", "Status:", ">", "<")):
            flush()
            continue
        if stripped.startswith("|"):
            flush()
            cells = split_row(stripped)
            if columns is None:
                columns = [c.lower() for c in cells]
                continue
            if all(re.fullmatch(r":?-+:?", c) for c in cells if c):
                continue
            for col, cell in zip(columns, cells):
                prose = col in PROSE_COLUMNS or len(strip_code(cell).split()) >= 5
                if prose and not is_token(cell):
                    for p in sentence_problems(cell):
                        findings.append((i, f"{col} cell {p}", cell))
            continue
        item = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$", line)
        if item:
            flush()
            block.append((i, item.group(1)))
            continue
        block.append((i, line))    # a paragraph line, or a list item's continuation
    flush()
    return findings


def main(argv):
    total = 0
    for path in argv:
        if path.endswith(SKIP_FILES):
            continue
        for line, problem, text in check(path):
            total += 1
            snippet = text if len(text) <= 90 else text[:87] + "..."
            print(f"{path}:{line}: {problem}\n    {snippet}")
    if total:
        print(f"\n{total} finding(s). Rewrite each as complete, simple sentences without dashes.")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
