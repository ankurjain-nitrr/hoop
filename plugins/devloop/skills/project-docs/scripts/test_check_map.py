import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_map  # noqa: E402

PRD = """# Shop PRD

## 1. Overview and objectives

- NFR-1: Pages load in under a second. Acceptance: a page loads in under a second. Changes: CR-2.

## 2. User interactions and flows

### Exporting orders

- FR-1: When a person exports, the product shall write a file. Acceptance: the file opens. Changes: CR-1.
- FR-2: When a filter is set, the export shall hold only matching orders. Acceptance: it does. Changes: CR-3.
"""

LLD = """# Shop LLD

## Export

- Responsibility: write the export (FR-1, FR-2).

## Test plan

| Requirement | Tests | What the tests prove | Level |
|---|---|---|---|
| FR-1 to FR-2 | `export.test.ts`: `writes rows` | Rows are written. | Unit. |
| NFR-1 | `load.test.ts`: `loads fast` | The page loads in time. | Browser. |

## Pull requests

| Requirement | Note |
|---|---|
| FR-9 | This table isn't the test plan. |
"""

HLD = """# Shop HLD

## Cross-cutting concerns

- Performance: the page stays fast for NFR-1.
"""

MAP = """# Notes

| Fact | Old place | New place |
|---|---|---|
| FR-1 | PRD, Requirements | FR-1 |
| The speed target | PRD, Success metrics | PRD.md, "Overview and objectives" |
| Running without a shell | PRD, NFR-9 | HLD.md, "Cross-cutting concerns" |
| FR-4 | PRD, Requirements | Retired |

## Retired

- FR-4: it described how the code is built.
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, name, text):
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check_map.main(list(args))
        return code, out.getvalue().splitlines()


class FactMapTest(Base):
    def docs(self):
        return [self.write("PRD.md", PRD), self.write("HLD.md", HLD), self.write("LLD.md", LLD)]

    def test_a_complete_map_passes(self):
        code, lines = self.run_main(self.write("NOTES.md", MAP), *self.docs())
        self.assertEqual((code, lines), (0, []))

    def test_a_requirement_found_nowhere_is_reported(self):
        text = MAP.replace("| FR-1 | PRD, Requirements | FR-1 |", "| FR-8 | PRD, Requirements | FR-8 |")
        map_path = self.write("NOTES.md", text)
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f"{map_path}:5: FR-8 appears in no new document and isn't retired"])

    def test_an_id_does_not_match_a_longer_id(self):
        text = MAP.replace("| FR-1 | PRD, Requirements | FR-1 |", "| FR-12 | PRD | FR-12 |")
        map_path = self.write("NOTES.md", text)
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertIn("FR-12 appears in no new document", lines[0])

    def test_a_retired_requirement_needs_no_new_place(self):
        text = MAP.replace("| FR-1 | PRD, Requirements | FR-1 |", "| FR-4 | PRD | FR-4 |")
        code, lines = self.run_main(self.write("NOTES.md", text), *self.docs())
        self.assertEqual((code, lines), (0, []))

    def test_a_retired_row_must_be_in_the_retired_list(self):
        text = MAP.replace("- FR-4: it described how the code is built.", "- Nothing else.")
        map_path = self.write("NOTES.md", text)
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f"{map_path}:8: FR-4 is marked retired but isn't in a Retired list"])

    def test_a_missing_heading_is_reported(self):
        text = MAP.replace('"Cross-cutting concerns"', '"Security concerns"')
        map_path = self.write("NOTES.md", text)
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f'{map_path}:7: no heading "Security concerns" in HLD.md'])

    def test_a_heading_must_be_in_the_named_document(self):
        text = MAP.replace('HLD.md, "Cross-cutting concerns"', 'LLD.md, "Cross-cutting concerns"')
        code, lines = self.run_main(self.write("NOTES.md", text), *self.docs())
        self.assertEqual(code, 1)
        self.assertIn('no heading "Cross-cutting concerns" in LLD.md', lines[0])

    def test_a_heading_matches_without_its_number(self):
        text = MAP.replace('"Overview and objectives"', '"1. Overview and objectives"')
        code, lines = self.run_main(self.write("NOTES.md", text), *self.docs())
        self.assertEqual((code, lines), (0, []))

    def test_an_unknown_document_is_reported(self):
        text = MAP.replace('PRD.md, "Overview', 'GUIDE.md, "Overview')
        code, lines = self.run_main(self.write("NOTES.md", text), *self.docs())
        self.assertEqual(code, 1)
        self.assertIn("GUIDE.md isn't one of the new documents", lines[0])

    def test_an_empty_or_vague_new_place_is_reported(self):
        text = MAP.replace("| FR-1 | PRD, Requirements | FR-1 |", "| FR-1 | PRD | |\n| A note | PRD | somewhere |")
        map_path = self.write("NOTES.md", text)
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(
            lines,
            [
                f"{map_path}:5: the fact has no new place",
                f"{map_path}:6: the new place names no requirement, heading or document",
            ],
        )

    def test_a_ranged_new_place_needs_every_id(self):
        text = MAP.replace("| FR-1 | PRD, Requirements | FR-1 |", "| Export | PRD | FR-1 to FR-3 |")
        code, lines = self.run_main(self.write("NOTES.md", text), *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 1)
        self.assertIn("FR-3 appears in no new document", lines[0])

    def test_a_file_without_a_map_table_is_reported(self):
        map_path = self.write("NOTES.md", "# Notes\n\nNo table here.\n")
        code, lines = self.run_main(map_path, *self.docs())
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f"{map_path}:1: no table with the columns Fact, Old place and New place"])


class TestPlanTest(Base):
    def test_every_requirement_with_a_row_passes(self):
        code, lines = self.run_main("--prd", self.write("PRD.md", PRD), "--lld", self.write("LLD.md", LLD))
        self.assertEqual((code, lines), (0, []))

    def test_a_requirement_without_a_row_is_reported(self):
        prd = self.write("PRD.md", PRD + "- FR-9: When asked, it shall stop. Acceptance: it stops. Changes: CR-4.\n")
        code, lines = self.run_main("--prd", prd, "--lld", self.write("LLD.md", LLD))
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f"{prd}:13: FR-9 has no row in the LLD's test plan"])

    def test_an_lld_without_a_test_plan_is_reported(self):
        lld = self.write("LLD.md", "# Shop LLD\n\n## Export\n")
        code, lines = self.run_main("--prd", self.write("PRD.md", PRD), "--lld", lld)
        self.assertEqual(code, 1)
        self.assertEqual(lines, [f"{lld}:1: no Test plan section"])

    def test_the_map_and_the_test_plan_run_together(self):
        prd, lld = self.write("PRD.md", PRD), self.write("LLD.md", LLD)
        hld = self.write("HLD.md", HLD)
        code, lines = self.run_main(self.write("NOTES.md", MAP), hld, "--prd", prd, "--lld", lld)
        self.assertEqual((code, lines), (0, []))


class UsageTest(Base):
    def test_prd_needs_lld(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            check_map.main(["--prd", "PRD.md"])
        self.assertEqual(raised.exception.code, 2)

    def test_a_missing_file_exits_two(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            check_map.main([os.path.join(self.dir.name, "nope.md"), os.path.join(self.dir.name, "PRD.md")])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
