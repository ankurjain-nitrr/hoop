"""Tests for the checker's rules by document kind: python3 -m unittest test_document_rules"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from check_writing import check

SECTIONS = """## 1. Overview and objectives

Users export orders.

## 2. User interactions and flows

{flows}

## 3. UI states and transitions

None. The change has no screens.

## 4. Edge cases and error handling

None. The flows above cover every case.

## 5. Out of scope

- Imports stay as they are.
"""


def write(folder, name, text):
    path = os.path.join(folder, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def problems(path):
    return [p for _, p, _ in check(path)]


class DocumentRules(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        # The working folder holds no list, so only the ones a test writes count.
        self.here = os.getcwd()
        os.chdir(tempfile.mkdtemp())

    def tearDown(self):
        os.chdir(self.here)

    def prd(self, flows, name="PRD.md"):
        return write(self.dir, name, "# CR-7 PRD: Order export\n\nStatus: draft\n\n" + SECTIONS.format(flows=flows))

    def test_clean_prd_passes(self):
        path = self.prd("- FR-1: The page shall offer a CSV download. Acceptance: a user downloads the file. Changes: CR-7.")
        self.assertEqual(problems(path), [])

    def test_prd_flags_each_code_name_once(self):
        flows = "\n".join([
            "- FR-1: The export shall use src/export/csv.ts to write rows. Acceptance: rows arrive. Changes: CR-7.",
            "- FR-2: The export shall pass export.test.ts in CI. Acceptance: it passes. Changes: CR-7.",
            "- FR-3: The page shall call `writeRows(stream)` once. Acceptance: one call. Changes: CR-7.",
            "- FR-4: The page shall post to /api/export with the filter. Acceptance: a reply comes. Changes: CR-7.",
            "- FR-5: The export shall live in `server.py` today. Acceptance: it runs. Changes: CR-7.",
        ])
        found = problems(self.prd(flows))
        self.assertEqual(sum("file path src/export/csv.ts" in p for p in found), 1, found)
        self.assertEqual(sum("test file export.test.ts" in p and "LLD's test plan" in p for p in found), 1, found)
        self.assertEqual(sum("function call writeRows(stream)" in p for p in found), 1, found)
        self.assertEqual(sum("web route /api/export" in p for p in found), 1, found)
        self.assertEqual(sum("source file server.py" in p for p in found), 1, found)
        self.assertEqual(len(found), 5, found)

    def test_requirement_without_change_tag(self):
        found = problems(self.prd("- FR-1: The page shall offer a CSV download. Acceptance: a user downloads it."))
        self.assertEqual(len(found), 1)
        self.assertIn("no change tag", found[0])

    def test_allowed_names_are_never_flagged(self):
        flows = "- FR-1: A person shall list their names in docs/allowed-names.txt. Acceptance: the list works. Changes: CR-7."
        path = self.prd(flows)
        self.assertEqual(len(problems(path)), 1)
        write(self.dir, "docs/allowed-names.txt", "# names\ndocs/allowed-names.txt\n")
        self.assertEqual(problems(path), [])

    def test_allowed_names_found_from_the_working_folder(self):
        write(self.dir, "docs/allowed-names.txt", "docs/allowed-names.txt\n")
        other = tempfile.mkdtemp()
        path = write(other, "copy.md", "# CR-7 PRD: x\n\n" + SECTIONS.format(
            flows="- FR-1: A person shall edit docs/allowed-names.txt. Acceptance: it works. Changes: CR-7."))
        os.chdir(self.dir)
        self.assertEqual(problems(path), [])

    def test_old_shape_prd_gets_one_finding(self):
        path = write(self.dir, "PRD.md", "# hoop PRD\n\n## Requirements\n\n- FR-1: It shall use src/a.ts.\n")
        found = problems(path)
        self.assertEqual(len(found), 1, found)
        self.assertIn("five-section shape", found[0])

    def test_changes_to_current_behavior_are_not_requirements(self):
        flows = "- FR-1: The page shall offer a CSV download. Acceptance: a user downloads it. Changes: CR-7."
        text = "# CR-7 PRD: x\n\n" + SECTIONS.format(flows=flows).replace(
            "Users export orders.", "Users export orders.\n\n### Changes to current behavior\n\n- FR-9: The old export goes.")
        self.assertEqual(problems(write(self.dir, "PRD.md", text)), [])

    def test_design_documents_name_no_change_request(self):
        path = write(self.dir, "HLD.md", "# CR-7 HLD: Export\n\nStatus: draft · CR-7\n\nThe exporter serves FR-1, as CR-5 did.\n\n```\nCR-6\n```\n")
        found = problems(path)
        self.assertEqual(len(found), 2, found)
        self.assertTrue(all("change request" in p for p in found))
        lld = write(self.dir, "LLD.md", "# CR-7 LLD: Export\n\nThe writer serves FR-1.\n")
        self.assertEqual(problems(lld), [])

    def test_a_kind_named_file_needs_its_kind_in_the_title(self):
        found = problems(write(self.dir, "HLD.md", "# Export design\n\nThe exporter serves FR-1.\n"))
        self.assertEqual(len(found), 1, found)
        self.assertIn("names no kind", found[0])
        self.assertEqual(problems(write(self.dir, "notes.md", "# Export design\n\nThe exporter serves FR-1, as CR-5 did.\n")), [])

    def test_the_same_findings_on_the_file_and_on_a_copy(self):
        flows = "- FR-1: The export shall use src/a.ts. Acceptance: it works. Changes: CR-7."
        path = self.prd(flows)
        copy = write(tempfile.mkdtemp(), "doc.md", open(path, encoding="utf-8").read())
        self.assertEqual(problems(path), problems(copy))

    def test_front_matter_is_not_checked_for_code(self):
        flows = "- FR-1: The page shall offer a CSV download. Acceptance: a user downloads it. Changes: CR-7."
        text = "---\nname: export.ts\nroute: /api/export\n---\n" + "# CR-7 PRD: Order export\n\n" + SECTIONS.format(flows=flows)
        self.assertEqual(problems(write(self.dir, "PRD.md", text)), [])

    def test_requests_are_skipped(self):
        from check_writing import main
        path = write(self.dir, "REQUEST.md", "# HLD for CR-9 — please\n")
        self.assertEqual(main([path]), 0)


if __name__ == "__main__":
    unittest.main()
