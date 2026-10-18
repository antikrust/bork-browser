"""Raw Marionette client: <len>:<json> framing over TCP, nothing else.

For driving the dev browser (docs/development/dev-browser.md) from Python
when dev-tool's one-expression eval is not enough — trusted pointer input
through WebDriver:PerformActions, several tabs, async page scripts.

    from marionette import Mari
    m = Mari(2828); m.new_session(); m.content()
    m.send("WebDriver:Navigate", {"url": "https://www.youtube.com/"})
    print(m.script("arguments[arguments.length - 1](location.href)"))
"""
import json, socket
class Mari:
    def __init__(s, port, host="127.0.0.1"):
        s.sock = socket.create_connection((host, port), timeout=10); s.sock.settimeout(180)
        s.buf = b""; s.id = 0; s._read()
    def _read(s):
        while b":" not in s.buf: s.buf += s._recv()
        n, _, s.buf = s.buf.partition(b":"); n = int(n)
        while len(s.buf) < n: s.buf += s._recv()
        p, s.buf = s.buf[:n], s.buf[n:]; return json.loads(p)
    def _recv(s):
        c = s.sock.recv(65536)
        if not c: raise RuntimeError("closed")
        return c
    def send(s, cmd, params=None):
        s.id += 1; raw = json.dumps([0, s.id, cmd, params or {}]).encode()
        s.sock.sendall(str(len(raw)).encode() + b":" + raw)
        while True:
            m = s._read()
            if m[0] == 1 and m[1] == s.id:
                if m[2]: raise RuntimeError(f"{cmd}: {json.dumps(m[2])[:500]}")
                return m[3]
    def new_session(s):
        r = s.send("WebDriver:NewSession", {"capabilities": {}})
        s.send("WebDriver:SetTimeouts", {"script": 120000}); return r
    def chrome(s): s.send("Marionette:SetContext", {"value": "chrome"})
    def content(s): s.send("Marionette:SetContext", {"value": "content"})
    def script(s, src, timeout=120000):
        return s.send("WebDriver:ExecuteAsyncScript", {"script": src, "args": [], "scriptTimeout": timeout, "newSandbox": True})["value"]
