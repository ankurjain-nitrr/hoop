"""Self-test for check_practices.py: python3 test_check_practices.py"""
import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(__file__))
from check_practices import PRACTICES, main, missing


class CheckPractices(unittest.TestCase):
    def test_empty_repo_misses_every_practice(self):
        with tempfile.TemporaryDirectory() as repo:
            self.assertEqual([n for n, _ in missing(repo)], [p[0] for p in PRACTICES])
            self.assertEqual(main(["check", repo]), 1)

    def test_one_missing_practice_is_named(self):
        with tempfile.TemporaryDirectory() as repo:
            for _, paths, _ in PRACTICES:
                path = os.path.join(repo, paths[0].replace("*", "x"))
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, "w").close()
            os.remove(os.path.join(repo, "SECURITY.md"))
            self.assertEqual([n for n, _ in missing(repo)], ["security policy"])

    def test_this_repository_has_every_practice(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), *[".."] * 5))
        self.assertEqual(missing(root), [])
        self.assertEqual(main(["check", root]), 0)


if __name__ == "__main__":
    unittest.main()
