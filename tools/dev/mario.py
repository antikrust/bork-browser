#!/usr/bin/env python3
"""Minimal Marionette client: chrome-context eval + screenshot.

Stdlib-only, so it runs anywhere python3 exists — built for driving the
LINUX build headless on a remote host (xvfb-run … ./bork/bork --profile
/tmp/prof -marionette -remote-allow-system-access --no-remote), where the
repo's dev-tool isn't available. The chrome context requires the
-remote-allow-system-access flag. Expect the striped red urlbar in
screenshots: that is Firefox's :root[remotecontrol] warning, shown in any
Marionette session — users never see it.

Usage:
  mario.py eval  '<js expression>'          # chrome context, JSON result
  mario.py shot  /path/out.png              # full-window chrome screenshot
  mario.py port  <port>  ... (optional first pair, default 2828)
"""
import base64
import json
import socket
import sys


class Mario:
    def __init__(self, port=2828):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
        self.buf = b""
        self.msgid = 0
        self._read_msg()  # handshake blob
        self.cmd("WebDriver:NewSession", {})
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def _read_msg(self):
        while b":" not in self.buf:
            self.buf += self.sock.recv(65536)
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            rest += self.sock.recv(65536)
        msg, self.buf = rest[:n], rest[n:]
        return json.loads(msg)

    def cmd(self, name, params):
        self.msgid += 1
        payload = json.dumps([0, self.msgid, name, params]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read_msg()
            if isinstance(msg, list) and msg[0] == 1 and msg[1] == self.msgid:
                if msg[2]:
                    raise RuntimeError(json.dumps(msg[2]))
                return msg[3]

    def eval_js(self, expr):
        return self.cmd(
            "WebDriver:ExecuteScript",
            {"script": "return (%s);" % expr, "args": []},
        )

    def shot(self, path):
        r = self.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["value"]))


if __name__ == "__main__":
    args = sys.argv[1:]
    port = 2828
    if args and args[0] == "port":
        port = int(args[1])
        args = args[2:]
    m = Mario(port)
    if args[0] == "eval":
        print(json.dumps(m.eval_js(args[1])))
    elif args[0] == "shot":
        m.shot(args[1])
        print("saved", args[1])
