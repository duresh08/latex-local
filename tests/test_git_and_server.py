import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

os.environ.setdefault("LATEXLAB_HOME", tempfile.mkdtemp(prefix="latexlab-home-"))

from latexlab import toolchain  # noqa: E402
from latexlab.gitops import Git, GitError  # noqa: E402
from latexlab.server import App, make_server  # noqa: E402

HAS_GIT = toolchain.get().git is not None


def sh(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@unittest.skipUnless(HAS_GIT, "git not installed")
class GitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        sh(self.tmp, "init", "-q", "--bare", "-b", "main", "remote.git")
        self.work = self.tmp / "work"
        self.work.mkdir()
        (self.work / "main.tex").write_text("\\documentclass{article}\n")
        self.g = Git(self.work)
        self.g.init(str(self.tmp / "remote.git"))
        sh(self.work, "config", "user.name", "T")
        sh(self.work, "config", "user.email", "t@example.com")

    def test_first_sync_pushes_to_empty_remote(self):
        st = self.g.status()
        self.assertEqual(st["branch"], "main")
        self.assertFalse(st["hasCommits"])
        self.assertEqual([c["status"] for c in st["changes"]], ["new"])
        msg = self.g.sync("Import from Overleaf")["message"]
        self.assertIn("Pushed", msg)
        st = self.g.status()
        self.assertEqual((st["ahead"], st["behind"], st["changes"]), (0, 0, []))

    def test_pull_brings_remote_changes_and_conflicts_are_reported(self):
        self.g.sync("first")
        other = self.tmp / "other"
        sh(self.tmp, "clone", "-q", "remote.git", "other")
        sh(other, "config", "user.name", "O")
        sh(other, "config", "user.email", "o@example.com")
        (other / "main.tex").write_text("\\documentclass{report}\n")
        sh(other, "commit", "-qam", "overleaf edit")
        sh(other, "push", "-q", "origin", "main")
        (self.work / "main.tex").write_text("\\documentclass{book}\n")
        with self.assertRaises(GitError) as cm:
            self.g.sync("local edit")
        self.assertEqual(cm.exception.kind, "conflict")
        st = self.g.status()
        self.assertTrue(st["merging"])
        self.assertEqual(st["conflicts"], ["main.tex"])
        self.g.abort_merge()
        self.assertFalse(self.g.status()["merging"])

    def test_offline_push_is_explained(self):
        self.g.commit("x")
        self.g.set_remote("https://nonexistent.invalid/repo.git")
        with self.assertRaises(GitError) as cm:
            self.g.push()
        self.assertIn(cm.exception.kind, ("offline", "auth", "error"))

    def test_bad_remote_url(self):
        with self.assertRaises(GitError):
            self.g.set_remote("not a url")


class ServerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = App()
        root = Path(tempfile.mkdtemp())
        (root / "main.tex").write_text("\\documentclass{article}\n")
        cls.app.open_project(str(root))
        cls.srv = make_server(cls.app, 0, tries=1)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.app.port}"
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def req(self, path, token=True, host=None, method="GET", body=None):
        headers = {}
        if token:
            headers["X-LatexLab-Token"] = self.app.token
        if host:
            headers["Host"] = host
        r = urllib.request.Request(self.base + path, headers=headers, method=method, data=body)
        try:
            with self.opener.open(r, timeout=10) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_token_required(self):
        self.assertEqual(self.req("/api/state", token=False)[0], 403)
        self.assertEqual(self.req("/api/state")[0], 200)

    def test_dns_rebinding_blocked(self):
        self.assertEqual(self.req("/api/state", host="evil.example:80")[0], 403)

    def test_traversal_blocked(self):
        code, body = self.req("/api/file?path=../../etc/passwd")
        self.assertEqual(code, 400)

    def test_index_has_token_and_assets_have_js_mime(self):
        code, body = self.req("/", token=False)
        if code == 500:
            self.skipTest("UI not built")
        html = body.decode()
        self.assertIn(self.app.token, html)
        import re
        js = re.search(r'src="(/assets/[^"]+\.js)"', html).group(1)
        r = urllib.request.Request(self.base + js)
        with self.opener.open(r, timeout=10) as res:
            self.assertTrue(res.headers["Content-Type"].startswith("text/javascript"))

    def test_save_and_read_round_trip(self):
        body = json.dumps({"path": "new/file.tex", "content": "hello"}).encode()
        code, _ = self.req("/api/file", method="PUT", body=body)
        self.assertEqual(code, 200)
        code, data = self.req("/api/file?path=new/file.tex")
        self.assertEqual(json.loads(data)["content"], "hello")


if __name__ == "__main__":
    unittest.main()
