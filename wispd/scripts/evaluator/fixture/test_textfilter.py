import unittest

from textfilter import filter_lines


class FilterLinesTest(unittest.TestCase):
    def test_filters_matching_lines_in_order(self) -> None:
        lines = ["alpha", "beta", "alphabet", "gamma"]
        self.assertEqual(filter_lines(lines, "alpha"), ["alpha", "alphabet"])

    def test_no_match_is_empty(self) -> None:
        self.assertEqual(filter_lines(["alpha", "beta"], "z"), [])


if __name__ == "__main__":
    unittest.main()
