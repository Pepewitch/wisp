"""Small filtering utility used by the Wisp activation evaluator."""


def filter_lines(lines: list[str], query: str) -> list[str]:
    """Return lines containing query, preserving their original order."""
    return [line for line in lines if query in line]
