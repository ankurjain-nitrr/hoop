#!/usr/bin/env python3
"""Check a fact map against the documents it points to, and a PRD against its LLD's test plan.

A fact map is a markdown table with the columns `Fact | Old place | New place`. Each New place
names requirement IDs (FR-12, NFR-3, or a range such as FR-4 to FR-9), headings in double quotes,
or document file names. A requirement ID listed under a heading that starts with "Retired" needs
no new place.

Usage:
    check_map.py MAP DOC [DOC ...] [--prd PRD --lld LLD]
    check_map.py --prd PRD --lld LLD

Prints `path:line: message` for each finding. Exits 0 with no findings, 1 with findings, and 2
when a file can't be read.
"""

import argparse
import os
import re
import sys

ID = re.compile(r"(?<![\w-])((?:FR|NFR)-\d+)(?!\d)(?:\s+to\s+((?:FR|NFR)-\d+)(?!\d))?")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
QUOTED = re.compile(r'"([^"]+)"')
FILE_NAME = re.compile(r"[\w./-]+\.(?:md|txt)\b")
REQUIREMENT = re.compile(r"^\s*[-*]\s+((?:FR|NFR)-\d+):")
NUMBERING = re.compile(r"^\d+(?:\.\d+)*\.?\s+")


def ids(text):
    """Return the requirement IDs in text, with each range expanded."""
    found = []
    for match in ID.finditer(text):
        first, last = match.group(1), match.group(2)
        found.append(first)
        if last:
            prefix, start = first.rsplit("-", 1)
            last_prefix, end = last.rsplit("-", 1)
            if prefix == last_prefix and int(end) > int(start):
                found.extend(f"{prefix}-{n}" for n in range(int(start) + 1, int(end) + 1))
            else:
                found.append(last)
    return found


def cells(line):
    """Split a markdown table row into its cells, or return None for a line that isn't a row."""
    line = line.strip()
    if not line.startswith("|"):
        return None
    return [cell.strip() for cell in line.strip("|").split("|")]


def is_delimiter(row):
    return all(re.fullmatch(r":?-{3,}:?", cell) for cell in row)


def tables(lines):
    """Yield (header, rows), where rows are (line number, cells), for each table in lines."""
    i = 0
    while i < len(lines):
        header = cells(lines[i])
        below = cells(lines[i + 1]) if i + 1 < len(lines) else None
        if header and below and is_delimiter(below):
            rows = []
            j = i + 2
            while j < len(lines) and cells(lines[j]) is not None:
                rows.append((j + 1, cells(lines[j])))
                j += 1
            yield i + 1, header, rows
            i = j
        else:
            i += 1


def heading_key(text):
    return NUMBERING.sub("", text.strip()).strip().lower()


def headings(lines):
    return {heading_key(m.group(2)) for m in map(HEADING.match, lines) if m}


def retired(lines):
    """Return the IDs in list items under any heading whose text starts with "Retired"."""
    found = set()
    inside = False
    for line in lines:
        m = HEADING.match(line)
        if m:
            inside = heading_key(m.group(2)).startswith("retired")
            continue
        if inside and re.match(r"^\s*[-*]\s+", line):
            found.update(ids(line))
    return found


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()
    except OSError as error:
        print(f"{path}: can't read: {error.strerror}", file=sys.stderr)
        sys.exit(2)


def check_map(map_path, docs):
    """Return findings for each map row whose new place isn't in the documents."""
    findings = []
    map_lines = read(map_path)
    texts = {path: read(path) for path in docs}
    all_text = "\n".join("\n".join(lines) for lines in texts.values())
    present = set(ids(all_text))
    by_name = {os.path.basename(path): path for path in docs}
    all_headings = set().union(*(headings(lines) for lines in texts.values())) if texts else set()
    gone = retired(map_lines)

    maps = [t for t in tables(map_lines) if [c.lower() for c in t[1]][:3] == ["fact", "old place", "new place"]]
    if not maps:
        return [f"{map_path}:1: no table with the columns Fact, Old place and New place"]
    for _, header, rows in maps:
        for line_no, row in rows:
            place = row[2] if len(row) > 2 else ""
            where = f"{map_path}:{line_no}"
            if not place:
                findings.append(f"{where}: the fact has no new place")
                continue
            if place.lower().startswith("retired"):
                missing = [i for i in ids(" ".join(row[:2])) if i not in gone]
                for req in missing:
                    findings.append(f"{where}: {req} is marked retired but isn't in a Retired list")
                continue
            names = FILE_NAME.findall(place)
            quoted = QUOTED.findall(place)
            reqs = ids(QUOTED.sub("", place))
            for name in names:
                if os.path.basename(name) not in by_name:
                    findings.append(f"{where}: {name} isn't one of the new documents")
            for req in reqs:
                if req not in present and req not in gone:
                    findings.append(f"{where}: {req} appears in no new document and isn't retired")
            targets = [by_name[os.path.basename(n)] for n in names if os.path.basename(n) in by_name]
            for title in quoted:
                pool = set().union(*(headings(texts[t]) for t in targets)) if targets else all_headings
                if heading_key(title) not in pool:
                    inside = f" in {', '.join(os.path.basename(t) for t in targets)}" if targets else ""
                    findings.append(f'{where}: no heading "{title}"{inside}')
            if not (names or quoted or reqs):
                findings.append(f"{where}: the new place names no requirement, heading or document")
    return findings


def check_test_plan(prd_path, lld_path):
    """Return findings for each requirement in the PRD with no row in the LLD's test plan."""
    prd_lines = read(prd_path)
    lld_lines = read(lld_path)
    start = None
    level = 0
    for i, line in enumerate(lld_lines):
        m = HEADING.match(line)
        if m and "test plan" in heading_key(m.group(2)):
            start, level = i, len(m.group(1))
            break
    if start is None:
        return [f"{lld_path}:1: no Test plan section"]
    end = len(lld_lines)
    for i in range(start + 1, len(lld_lines)):
        m = HEADING.match(lld_lines[i])
        if m and len(m.group(1)) <= level:
            end = i
            break
    covered = set()
    for _, _, rows in tables(lld_lines[start:end]):
        for _, row in rows:
            covered.update(ids(row[0]))
    findings = []
    for number, line in enumerate(prd_lines, 1):
        m = REQUIREMENT.match(line)
        if m and m.group(1) not in covered:
            findings.append(f"{prd_path}:{number}: {m.group(1)} has no row in the LLD's test plan")
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="*", help="the fact map, then the new documents")
    parser.add_argument("--prd", help="the project PRD, to check against the LLD's test plan")
    parser.add_argument("--lld", help="the project LLD that holds the test plan")
    args = parser.parse_args(argv)
    if bool(args.prd) != bool(args.lld):
        parser.error("--prd and --lld go together")
    if not args.files and not args.prd:
        parser.error("give a fact map and its documents, or --prd and --lld")
    if len(args.files) == 1 and not args.prd:
        parser.error("give the new documents after the fact map")

    findings = []
    if args.files:
        docs = args.files[1:] + [p for p in (args.prd, args.lld) if p and p not in args.files]
        findings += check_map(args.files[0], docs)
    if args.prd:
        findings += check_test_plan(args.prd, args.lld)
    for finding in findings:
        print(finding)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
