"""Rewrite markdown links that escape docs/ to GitHub tree URLs.

Docs habitually link into the source tree (../packages/...) and the repo
root (../CHANGELOG.md) — valid on GitHub, unresolvable inside the built
site. This hook rewrites exactly those links (relative targets whose
resolution escapes docs/) to their blob URLs, so `mkdocs build --strict`
stays on for genuinely broken links. In-tree links are untouched.

Must run on_page_markdown: mkdocs validates links while parsing the
markdown, so an on_page_content rewrite would warn before it rewrote.
"""
import posixpath
import re

REPO = "https://github.com/anvai-labs/agentbrowser"
BRANCH = "develop"
# ](  <target>  [optional whitespace + title] )
MD_LINK = re.compile(r'(\]\()([^)\s]+)((?:\s+"[^"]*")?\))')


def on_page_markdown(markdown, page, config, files):
    src_path = posixpath.normpath(page.file.src_path)
    page_dir = posixpath.dirname(src_path)

    def sub(match):
        target = match.group(2)
        path, sep, anchor = target.partition("#")
        if not path:
            return match.group(0)
        # Resolve against the page's own directory; escaping docs/ is exactly
        # "the normalized path climbs above the root".
        resolved = posixpath.normpath(posixpath.join(page_dir, path))
        if not resolved.startswith("../"):
            return match.group(0)
        repo_path = resolved[len("../") :]
        github = f"{REPO}/blob/{BRANCH}/{repo_path}" + (f"#{anchor}" if sep else "")
        return match.group(1) + github + match.group(3)

    return MD_LINK.sub(sub, markdown)
