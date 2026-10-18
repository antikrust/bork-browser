"""Read an extension's storage.local straight from a profile, read-only.

Firefox keeps it in IndexedDB: storage/default/moz-extension+++<uuid>^userContextId=4294967295/idb/*.sqlite,
each record raw-snappy-compressed structured clone. Handles the JSON-shaped
values our extensions store. Copy the .sqlite (and -wal) out first; never
open a live profile's database in place. The uuid per add-on id is in the
profile's prefs.js, extensions.webextensions.uuids.

    python3 tools/testing/extension_storage.py <copied.sqlite>
"""
import json, sys
import sqlite3, struct
def snappy_raw(d):
    p, s, n = 0, 0, 0
    while True:
        b = d[p]; p += 1; n |= (b & 0x7F) << s
        if not b & 0x80: break
        s += 7
    o = bytearray()
    while p < len(d):
        t = d[p]; p += 1; k = t & 3
        if k == 0:
            l = t >> 2
            if l >= 60: e = l - 59; l = int.from_bytes(d[p:p+e], "little"); p += e
            l += 1; o += d[p:p+l]; p += l
        else:
            if k == 1: l = ((t >> 2) & 7) + 4; off = ((t >> 5) << 8) | d[p]; p += 1
            elif k == 2: l = (t >> 2) + 1; off = int.from_bytes(d[p:p+2], "little"); p += 2
            else: l = (t >> 2) + 1; off = int.from_bytes(d[p:p+4], "little"); p += 4
            for _ in range(l): o.append(o[-off])
    return bytes(o)
class C:
    def __init__(s, b): s.b, s.p, s.seen = b, 0, []
    def w(s): v = struct.unpack_from("<Q", s.b, s.p)[0]; s.p += 8; return v >> 32, v & 0xFFFFFFFF
    def st(s, d):
        n, l1 = d & 0x7FFFFFFF, bool(d & 0x80000000); z = n if l1 else 2*n
        r = s.b[s.p:s.p+z]; s.p += (z + 7) & ~7; return r.decode("latin-1" if l1 else "utf-16-le")
    def key(s):
        t, d = s.w()
        if t == 0xFFFF0013: return None
        return s.st(d) if t == 0xFFFF0004 else d
    def v(s):
        t, d = s.w()
        if t < 0xFFF00000: return struct.unpack("<d", struct.pack("<Q", (t << 32) | d))[0]
        if t in (0xFFFF0000, 0xFFFF0001): return None
        if t == 0xFFFF0002: return bool(d)
        if t == 0xFFFF0003: return struct.unpack("<i", struct.pack("<I", d))[0]
        if t == 0xFFFF0004: return s.st(d)
        if t in (0xFFFF0007, 0xFFFF0008):
            o = [None]*d if t == 0xFFFF0007 else {}; s.seen.append(o)
            while (k := s.key()) is not None: o[k] = s.v()
            return o
        if t == 0xFFFF000D: return s.seen[d]
        raise ValueError(hex(t))
def read(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True); out = {}
    for k, d in con.execute("select key, data from object_data"):
        c = C(snappy_raw(bytes(d))); c.w(); out["".join(chr(ch - 1) for ch in bytes(k)[1:])] = c.v()
    return out


if __name__ == "__main__":
    print(json.dumps(read(sys.argv[1]), indent=1, ensure_ascii=False))
