#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DualSubs · LLM 字幕翻译网关（零依赖，Python 3.8+）

作用：假冒 Google 翻译接口，把 DualSubs 发来的整段字幕交给 LLM 翻译，
      带术语表、带上下文、带缓存，返回 Google 原始格式，DualSubs 完全无感。

启动：
    LLM_BASE=https://你的中转站/v1 \
    LLM_KEY=sk-xxxx \
    LLM_MODEL=gpt-4o-mini \
    python3 dsl-gateway.py

可选环境变量：
    PORT=8787          监听端口
    CHUNK=30           每批句数（越小越快，越大上下文越好）
    WORKERS=4          并发批数
    LLM_TIMEOUT=60     单次 LLM 超时（秒）
    DEBUG=1            打印详细日志 + 记录原始请求到 raw.log
"""

import os
import re
import sys
import json
import time
import hashlib
import logging
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote_plus
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

LLM_BASE = os.environ.get("LLM_BASE", "https://api.example.com/v1").rstrip("/")
LLM_KEY = os.environ.get("LLM_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "60"))
PORT = int(os.environ.get("PORT", "8787"))
CHUNK = int(os.environ.get("CHUNK", "16"))
WORKERS = int(os.environ.get("WORKERS", "8"))
CACHE_DB = os.environ.get("CACHE_DB", os.path.join(BASE_DIR, "dsl_cache.db"))
DEBUG = os.environ.get("DEBUG", "0") == "1"

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("dsl")


# ---------------------------------------------------------------- 缓存
_db_lock = threading.Lock()
_conn = sqlite3.connect(CACHE_DB, check_same_thread=False)
_conn.execute("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)")
_conn.commit()


def cache_get(key):
    with _db_lock:
        row = _conn.execute("SELECT v FROM t WHERE k=?", (key,)).fetchone()
    return row[0] if row else None


def cache_put(key, val):
    with _db_lock:
        _conn.execute("INSERT OR REPLACE INTO t(k,v) VALUES(?,?)", (key, val))
        _conn.commit()


def cache_key(sl, tl, text):
    return hashlib.sha1(("%s|%s|%s" % (sl, tl, text)).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 术语表
DOMAIN_TRIGGERS = {
    "f1": ["drs", "verstappen", "norris", "leclerc", "piastri", "hamilton", "russell",
           "grand prix", "qualifying", "pit stop", "undercut", "safety car", "lap ",
           "f1", "formula 1", "tyre", "pole"],
    "mls": ["offside", "corner kick", "midfield", "penalty", "mls", "soccer", "goal",
            "keeper", "striker", "playoff", "leagues cup"],
    "fitness": ["squat", "lunge", "burpee", "plank", "rep", "set", "workout", "coach",
                "hiit", "core", "dumbbell", "kettlebell", "stretch", "mat"],
}


def load_glossaries():
    out = {}
    for dom in ["f1", "mls", "fitness", "general"]:
        path = os.path.join(BASE_DIR, "glossary", dom + ".json")
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            out[dom] = {k: v for k, v in data.items() if not k.startswith("_")}
        except Exception as exc:
            log.warning("术语表加载失败 %s: %s", path, exc)
            out[dom] = {}
    return out


GLOSSARY = load_glossaries()


def pick_domains(texts):
    """按关键词命中自动挑选术语表，始终带 general 兜底。"""
    blob = "\n".join(texts).lower()
    scores = {}
    for dom, keys in DOMAIN_TRIGGERS.items():
        scores[dom] = sum(blob.count(k) for k in keys)
    best = max(scores, key=lambda d: scores[d])
    picked = ["general"]
    if scores[best] > 0:
        picked.insert(0, best)
    return picked, scores


def glossary_block(domains):
    lines = []
    for dom in domains:
        for en, zh in GLOSSARY.get(dom, {}).items():
            lines.append("%s => %s" % (en, zh))
    return "\n".join(lines)


# ---------------------------------------------------------------- 提示词
SYSTEM_PROMPT = """你是专业的影视与体育字幕译者。用户会给你带编号的英文台词（来自英文隐藏式字幕 CC），你要逐条翻译成简体中文。

硬性规则：
1. 每条以 [编号] 开头。你必须为每一个编号都返回译文，编号一一对应，绝不合并、拆分、跳过或自行新增。
2. 只输出一个 JSON 对象：key 为编号字符串，value 为译文。不要输出任何解释、不要用代码块包裹。
3. 保留说话人标记 ">>"、音乐符号 "♪"、方括号音效（如 [engine revving]），只翻译其中的文字内容。
4. 数字、单位、缩写按术语表处理；术语表未收录的专有名词，自行统一译名并全篇一致。
5. 中文要口语自然、符合解说或对白语气，避免书面腔，不要添加引号或句末多余标点。

【术语表 · 必须严格遵守】
{glossary}
"""

USER_TMPL = """请翻译以下 {n} 条字幕：

{body}"""


# ---------------------------------------------------------------- LLM
def llm_chat(messages):
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": 0.2,
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LLM_KEY,
    }
    req = Request(LLM_BASE + "/chat/completions", data=data, headers=headers)
    try:
        with urlopen(req, timeout=LLM_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")[:400]
        raise RuntimeError("LLM HTTP %s: %s" % (exc.code, detail))
    except URLError as exc:
        raise RuntimeError("LLM 连接失败: %s" % exc.reason)


def parse_mapping(raw, n):
    """把模型输出解析成 {1..n} 的映射，缺号返回 None。"""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        text = match.group(0)
    obj = None
    try:
        obj = json.loads(text)
    except Exception:
        # 兜底：逐行 "[1] 译文" 形式
        obj = {}
        for line in text.splitlines():
            m = re.match(r"^\s*\[?(\d+)\]?\s*[:：\.]?\s*(.+)$", line)
            if m:
                obj[m.group(1)] = m.group(2).strip()
    if not isinstance(obj, dict):
        return [None] * n
    out = []
    for i in range(1, n + 1):
        val = obj.get(str(i))
        if val is None:
            val = obj.get(i)
        out.append(str(val).strip() if val else None)
    return out


def translate_chunk(texts, sl, tl):
    """翻译一批（含编号），返回与输入等长的译文列表（失败位置为 None）。"""
    body = "\n".join("[%d] %s" % (i + 1, t) for i, t in enumerate(texts))
    domains, scores = pick_domains(texts)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(glossary=glossary_block(domains))},
        {"role": "user", "content": USER_TMPL.format(n=len(texts), body=body)},
    ]
    raw = llm_chat(messages)
    result = parse_mapping(raw, len(texts))
    missing = sum(1 for x in result if not x)
    log.info("批次 %d 句 · 域=%s · 缺号 %d", len(texts), "+".join(domains), missing)
    if DEBUG:
        log.debug("模型原始输出片段: %s", (raw or "")[:300])
    return result


# ---------------------------------------------------------------- 主流程
def split_sentences(q):
    """拆句但保留空行占位，确保条数与原请求一致（条数一变，时间轴全乱）。"""
    text = q.replace("\r\n", "\n").replace("\r", "\n")
    parts = text.split("\n")
    if len(parts) == 1 and "|" in text:
        parts = text.split("|")
    return parts


def translate_all(parts, sl, tl):
    idx_todo = []
    results = [""] * len(parts)
    for i, text in enumerate(parts):
        if not text.strip():
            continue
        cached = cache_get(cache_key(sl, tl, text))
        if cached is not None:
            results[i] = cached
        else:
            idx_todo.append(i)

    hit = len([x for x in results if x])

    def run_pass(idxs, size, workers):
        if not idxs:
            return
        chunks = [idxs[i:i + size] for i in range(0, len(idxs), size)]

        def work(chunk):
            sub = [parts[i] for i in chunk]
            try:
                outs = translate_chunk(sub, sl, tl)
            except Exception as exc:
                log.error("批次失败: %s", exc)
                return
            for pos, i in enumerate(chunk):
                val = outs[pos]
                if val:
                    results[i] = val
                    cache_put(cache_key(sl, tl, parts[i]), val)

        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(chunks)))) as pool:
            list(pool.map(work, chunks))

    run_pass(idx_todo, CHUNK, WORKERS)

    # 编号守恒兜底：LLM 偶尔漏行，用小批补译，最多两轮
    for rnd in (1, 2):
        miss = [i for i in idx_todo if not results[i]]
        if not miss:
            break
        log.info("补译第 %d 轮 · %d 句", rnd, len(miss))
        run_pass(miss, 8, 4)

    fallback = 0
    for i, text in enumerate(parts):
        if text.strip() and not results[i]:
            results[i] = text
            fallback += 1
    return results, hit, fallback

def to_google(parts, translations, sl, dj):
    pairs = list(zip(parts, translations))
    if dj:
        return {
            "sentences": [{"trans": t, "orig": o, "backend": 10} for o, t in pairs],
            "src": sl,
            "confidence": 1.0,
            "ld_result": {
                "srclangs": [sl],
                "srclangs_confidences": [1.0],
                "extended_srclangs": [sl],
            },
        }
    return [[[t, o, None, None, 10] for o, t in pairs], None, sl]


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)

    def _reply(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, params):
        q = params.get("q") or ""
        sl = params.get("sl") or "auto"
        tl = params.get("tl") or "zh-CN"
        dj_raw = params.get("dj")
        dj = dj_raw is True or dj_raw == 1 or str(dj_raw or "0") in ("1", "true")

        if not q:
            self._reply(400, {"error": "empty q"})
            return

        if DEBUG:
            try:
                with open(os.path.join(BASE_DIR, "raw.log"), "a", encoding="utf-8") as f:
                    f.write(json.dumps({"q": q[:2000], "sl": sl, "tl": tl, "dj": dj},
                                       ensure_ascii=False) + "\n")
            except Exception:
                pass

        parts = split_sentences(q)
        started = time.time()
        try:
            translations, hit, fallback = translate_all(parts, sl, tl)
        except Exception as exc:
            log.error("翻译整体失败: %s", exc)
            translations = parts
            hit, fallback = 0, len(parts)

        elapsed = time.time() - started
        log.info("请求完成: %d 句 · 缓存命中 %d · 回填原文 %d · %.1fs",
                 len(parts), hit, fallback, elapsed)
        self._reply(200, to_google(parts, translations, sl, dj))

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "ignore") if length else ""
        params = {}
        if raw:
            try:
                params = json.loads(raw)
            except Exception:
                params = {k: v[0] for k, v in parse_qs(raw).items()}
        # Loon 可能把 q 留在 URL 上、body 里另带参数，两边合并
        url_params = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        merged = dict(url_params)
        merged.update(params)
        self._handle(merged)

    def do_GET(self):
        params = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        self._handle(params)


def main():
    if not LLM_KEY:
        log.warning("未设置 LLM_KEY，翻译会失败（仅能返回原文）")
    log.info("网关已启动 http://0.0.0.0:%d", PORT)
    log.info("LLM: %s · 模型: %s · 批次: %d 句 · 并发: %d", LLM_BASE, LLM_MODEL, CHUNK, WORKERS)
    log.info("术语表: " + ", ".join("%s(%d)" % (d, len(GLOSSARY[d])) for d in GLOSSARY))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到中断，退出")
        server.server_close()


if __name__ == "__main__":
    main()
