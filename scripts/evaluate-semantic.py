"""Fixed multilingual retrieval benchmark. Model weights and output stay outside Git."""
import argparse
import importlib.util
import json
import os
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("embedder", Path(__file__).with_name("local-embedder.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DOCS = [
    "برای تمدید گواهی TLS پیش از پایان اعتبار، از مدیر زیرساخت بخواهید اعتبارنامهٔ تازه نصب کند.",
    "Recovering a deleted invoice requires checking the ledger and opening an accounting correction.",
    "برنامهٔ بازگردانی فایل‌ها از نسخهٔ پشتیبان هر جمعه در محیط آزمایشی بررسی می‌شود.",
    "An outage on the authentication server requires failing over to the secondary cluster.",
    "برای استخدام توسعه‌دهنده ابتدا جلسهٔ مصاحبه و بررسی نمونه کار تنظیم شود.",
    "The marketing calendar lists the social media posts planned for the launch.",
    "برای اتصال از راه دور، کلید عمومی همتا را در پیکربندی WireGuard ثبت کنید.",
    "Project expenses are allocated equally among shared services in the infrastructure ledger.",
]
QUERIES = [
    ("How do I rotate an expiring HTTPS certificate?", 0),
    ("سند مالی حذف‌شده را چطور اصلاح کنم؟", 1),
    ("Where are the procedures for restoring lost files?", 2),
    ("اگر سرویس ورود قطع شد، از کدام سرور جایگزین استفاده کنیم؟", 3),
    ("برای جذب برنامه‌نویس چه مراحلی داریم؟", 4),
    ("How do we add an authorized VPN peer?", 6),
]

NO_EVIDENCE = [
    "What tools are used to trim a bonsai tree?",
    "نحوه تعیین وزن مولکولی آمونیاک چگونه است؟",
    "What are the rules for scoring in basketball?",
    "کدام سیاره نزدیک‌تر به خورشید است؟",
]


def peak_memory():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("page_faults", wintypes.DWORD),
                        ("peak", ctypes.c_size_t)] + [(name, ctypes.c_size_t) for name in (
                            "working_set", "peak_paged_pool", "paged_pool", "peak_nonpaged_pool",
                            "nonpaged_pool", "pagefile", "peak_pagefile")]

        info = Counters()
        info.size = ctypes.sizeof(info)
        query = ctypes.windll.psapi.GetProcessMemoryInfo
        query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        return info.peak if query(-1, ctypes.byref(info), info.size) else None
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if os.uname().sysname == "Darwin" else peak * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    options = parser.parse_args()
    start = time.perf_counter()
    model = module.LocalEmbedder(options.model_dir)
    loaded = time.perf_counter()
    index = module.np.array([model.embed([doc], "passage")[0] for doc in DOCS])
    indexed = time.perf_counter()
    ranks = []
    false_matches = 0
    for question, target in QUERIES + [(question, None) for question in NO_EVIDENCE]:
        vector = model.embed([question], "query")[0]
        thresholds = model.thresholds(vector)
        scores = module.np.asarray(vector) @ index.T
        ranked = []
        if scores.max() >= thresholds["minimumBest"]:
            ranked = [int(i) for i in scores.argsort()[::-1][:3] if scores[i] > thresholds["minimumCitation"]]
        if target is None:
            false_matches += bool(ranked)
        else:
            ranks.append(ranked.index(target) + 1 if target in ranked else 0)
    queried = time.perf_counter()
    recall = sum(0 < rank <= 3 for rank in ranks) / len(ranks)
    mrr = sum(1 / rank for rank in ranks if rank) / len(ranks)
    print(json.dumps({"model": module.MODEL_ID, "ranks": ranks, "recall_at_3": recall, "mrr": mrr,
                      "false_matches": false_matches, "no_evidence_queries": len(NO_EVIDENCE),
                      "load_seconds": loaded - start, "index_seconds": indexed - loaded,
                      "query_seconds": queried - indexed, "vector_bytes": index.nbytes,
                      "peak_rss_bytes": peak_memory()}))
    if recall < 0.75 or mrr < 0.60 or false_matches:
        raise SystemExit("Retrieval quality below acceptance threshold")


if __name__ == "__main__":
    main()
