#!/usr/bin/env python3
"""Checks markdown documents against the devloop writing rules.

Rules for every document: complete sentences (list items, prose table cells and paragraphs end with
a period and start with a capital), simple language (sentences of 25 words at most), and no em or
en dashes.

Rules by kind, which the title names ("# CR-7 PRD: ...", "# hoop HLD"):
- A PRD in the five-section shape names no file path, source or test file, function call or web
  route, unless the project lists the name in docs/allowed-names.txt, and every requirement ends
  with its change tag ("Changes: CR-3, CR-22."). A PRD in an older shape gets one finding instead.
- An HLD or an LLD names no change request outside its title and status line.
- A file named for a kind (PRD.md, HLD.md, LLD.md) whose title names no kind gets one finding.

Usage: check_writing.py <file.md>... ; exits 1 if there are findings.
"""
import os
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


# A PRD's five sections, in order (the template's headings, numbered or not).
PRD_SECTIONS = ["overview and objectives", "user interactions and flows", "ui states and transitions",
                "edge cases and error handling", "out of scope"]
# A title names its kind as "<name> PRD" at its end or "PRD:" before the document's name.
KIND = re.compile(r"\b(PRD|HLD|LLD)(?=:|\s*$)")
CR_NAME = re.compile(r"\bCR-(?:\d+|<n>)\b")
REQUIREMENT = re.compile(r"^\s*[-*+]\s+(?:\*\*)?(N?FR-\d+[a-z]?)(?:\*\*)?:")
CHANGE_TAG = re.compile(r"Changes:\s*CR-(?:\d+|<n>)(?:\s*,\s*CR-(?:\d+|<n>))*\.?\s*$")
CODE_EXT = r"(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|kt|swift|c|h|cpp|cs|php|css|scss|html|sh|sql)"
# What a PRD never names, each with what to write instead. Inline code counts too.
CODE_NAMES = [
    (re.compile(r"(?<![\w/.~-])~?\.{0,2}/?(?:[\w.-]+/)+[\w.-]+\.\w{1,5}\b"),
     "names the file path {}; a PRD names only what users type, read or set. Move it to the HLD or LLD, "
     "or list it in docs/allowed-names.txt if users edit it"),
    (re.compile(r"(?<![\w/.-])[\w-]+\.(?:test|spec)\." + CODE_EXT + r"\b"),
     "names the test file {}; move the test to the LLD's test plan, and keep the acceptance sentence"),
    (re.compile(r"(?<![\w/.-])[\w-]+\." + CODE_EXT + r"\b"),
     "names the source file {}; describe what users see, and leave files to the HLD and LLD"),
    (re.compile(r"(?<![\w.])[A-Za-z_][\w.]*\((?!e?s\))[^()\s]*\)"),
     "names the function call {}; describe the behavior users see instead"),
    (re.compile(r"(?<![\w.~/:-])/(?:[a-z][\w-]*)(?:/[\w<>{}:.-]+)*"),
     "names the web route {}; name the page or command users see instead"),
]


def doc_kind(lines):
    """PRD, HLD or LLD, from the document's title, or None."""
    title = next((l for l in lines if l.startswith("# ")), "")
    m = KIND.search(title)
    return m.group(1) if m else None


def find_upward(start, name):
    """The first `name` in `start` or one of its parents, or None."""
    here = os.path.abspath(start)
    while True:
        path = os.path.join(here, name)
        if os.path.isfile(path):
            return path
        up = os.path.dirname(here)
        if up == here:
            return None
        here = up


def allowed_names(path):
    """The names a project's users type that look like code: docs/allowed-names.txt, looked for from
    the document's folder upward, then from the working folder upward. One name per line; # comments."""
    found = find_upward(os.path.dirname(os.path.abspath(path)), os.path.join("docs", "allowed-names.txt")) or find_upward(
        os.getcwd(), os.path.join("docs", "allowed-names.txt"))
    if not found:
        return set()
    names = set()
    with open(found, encoding="utf-8") as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if line:
                names.add(line)
    return names


def headings(lines):
    return [(i, l) for i, l in enumerate(lines, 1) if re.match(r"^##\s", l)]


def section_name(text):
    return re.sub(r"^##\s+(?:\d+\.\s*)?", "", text).strip().lower()


def has_prd_shape(lines):
    names = [section_name(l) for _, l in headings(lines)]
    at = [names.index(s) if s in names else -1 for s in PRD_SECTIONS]
    return all(a >= 0 for a in at) and at == sorted(at)


def prose_lines(lines):
    """Each line outside fenced code and front matter, with its number."""
    in_code = False
    for i, line in enumerate(lines, 1):
        if line.strip().startswith(("```", "~~~")):
            in_code = not in_code
            continue
        if not in_code:
            yield i, line


def prd_findings(path, lines):
    """A PRD's rules: its shape, the names it never holds, and each requirement's change tag."""
    if not has_prd_shape(lines):
        title = next((i for i, l in enumerate(lines, 1) if l.startswith("# ")), 1)
        return [(title, "this PRD isn't in the five-section shape; move it to the template's sections: "
                 + ", ".join(PRD_SECTIONS), lines[title - 1].strip())]
    allowed = allowed_names(path)
    out = []
    for i, line in prose_lines(lines):
        if line.startswith("# "):
            continue
        text = line.replace("`", " ")
        taken = []
        for pattern, message in CODE_NAMES:
            for m in pattern.finditer(text):
                name = m.group(0)
                if name in allowed or any(m.start() < e and s < m.end() for s, e in taken):
                    continue
                taken.append((m.start(), m.end()))
                out.append((i, message.format(name), line.strip()))
    # Each requirement, as one list item, ends with its change tag.
    # Items under "Changes to current behavior" name existing requirements; they aren't requirements.
    items, current, listing = [], None, True
    for i, line in prose_lines(lines):
        if line.startswith("#"):
            listing = not re.search(r"changes to current behavior", line, re.I)
            current = None
            continue
        if listing and REQUIREMENT.match(line):
            current = [i, line.strip()]
            items.append(current)
        elif current and line.strip() and re.match(r"^\s{2,}\S", line) and not re.match(r"^\s*[-*+]\s", line):
            current[1] += " " + line.strip()
        else:
            current = None
    for item in items:
        if not CHANGE_TAG.search(item[1]):
            out.append((item[0], "requirement has no change tag; end it with the change requests that changed it, "
                        "oldest first, such as Changes: CR-3, CR-22.", item[1]))
    return out


def design_findings(lines):
    """An HLD's or LLD's rule: no change request name outside its title and status line."""
    out = []
    for i, line in enumerate(lines, 1):
        if line.startswith("# ") or line.strip().startswith("Status:"):
            continue
        for m in CR_NAME.finditer(line):
            out.append((i, f"names the change request {m.group(0)}; point to the requirements it serves, "
                           "and keep links between changes in the notes or the tracker", line.strip()))
    return out


def kind_findings(path, lines):
    """The rules for the document's kind, and a file named for a kind whose title names none."""
    kind = doc_kind(lines)
    named = os.path.basename(path).upper()
    if kind is None and named in ("PRD.MD", "HLD.MD", "LLD.MD"):
        title = next((i for i, l in enumerate(lines, 1) if l.startswith("# ")), 1)
        return [(title, f"this file is named {os.path.basename(path)}, but its title names no kind; "
                 f"name it in the title, such as # CR-7 {named[:3]}: <name>", lines[title - 1].strip() if lines else "")]
    if kind == "PRD":
        return prd_findings(path, lines)
    if kind in ("HLD", "LLD"):
        return design_findings(lines)
    return []


def check(path):
    findings = []
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
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
    findings.extend(kind_findings(path, [l.rstrip("\r") for l in lines]))
    return sorted(findings, key=lambda f: f[0])


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
