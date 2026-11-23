"""Loopback-only inference for the published multilingual-e5-base ONNX model."""
import argparse
import hashlib
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


MODEL_ID = "multilingual-e5-base-v1"
ASSETS = {
    "model_qint8_avx512_vnni.onnx": "2523551878658b305550d8759443822dbfda9ed9c8012ef2c354ba2c5b9de503",
    "tokenizer.json": "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
}
# Background passages calibrate cosine scores per question and language.
BACKGROUND = [
    "This document contains general information about the requested topic.",
    "Please see the following overview and contact the responsible team for more information.",
    "The procedure lists the recommended steps, conditions, and follow-up actions.",
    "این سند حاوی اطلاعات عمومی درباره موضوع مورد نظر است.",
    "برای کسب اطلاعات بیشتر به توضیحات زیر و تیم مسئول مراجعه کنید.",
    "در این راهنما شرایط، مراحل پیشنهادی و اقدامات بعدی توضیح داده شده‌اند.",
    "Bird migration patterns vary with seasonal temperatures and food availability.",
    "برای شروع نوازندگی، ابتدا وضعیت نشستن و ریتم‌خوانی را تمرین کنید.",
    "A baking stone can be preheated for a crisp pizza crust.",
    "موقع شستن لباس پشمی از آب سرد استفاده کنید.",
]


class LocalEmbedder:
    def __init__(self, model_dir):
        base = Path(model_dir)
        for filename, expected in ASSETS.items():
            with (base / filename).open("rb") as asset:
                if hashlib.file_digest(asset, "sha256").hexdigest() != expected:
                    raise ValueError("Semantic model asset checksum mismatch")
        self.tokenizer = Tokenizer.from_file(str(base / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding()
        settings = ort.SessionOptions()
        settings.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(base / "model_qint8_avx512_vnni.onnx"),
                                            sess_options=settings, providers=["CPUExecutionProvider"])
        if self.session.get_outputs()[0].shape[-1] != 768:
            raise ValueError("Expected multilingual-e5-base model weights")
        self.background = np.array(self.embed(BACKGROUND, "passage"))

    def embed(self, texts, role):
        tokens = self.tokenizer.encode_batch([role + ": " + text for text in texts])
        ids = np.array([token.ids for token in tokens], dtype=np.int64)
        masks = np.array([token.attention_mask for token in tokens], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": masks, "token_type_ids": np.zeros_like(ids)}
        output = self.session.run(None, {item.name: feeds[item.name] for item in self.session.get_inputs()})[0]
        pooled = (output * masks[:, :, None]).sum(axis=1) / masks.sum(axis=1)[:, None]
        normalized = pooled / np.maximum(np.linalg.norm(pooled, axis=1)[:, None], 1e-8)
        return np.round(normalized, 8).tolist()

    def thresholds(self, vector):
        scores = self.background @ np.asarray(vector)
        return {"minimumBest": float(scores.max()),
                "minimumCitation": float(np.median(scores) + np.std(scores))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, default=8766)
    opts = parser.parse_args()
    model = LocalEmbedder(opts.model_dir)
    token = os.environ["PROJECTOS_SEMANTIC_TOKEN"]
    if len(token) < 32 or not token.isascii():
        raise ValueError("Expected a local service credential")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(8)

        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != "/embed" or not hmac.compare_digest(
                self.headers.get("Authorization", "").encode("utf8"), ("Bearer " + token).encode("ascii")
            ):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 300000:
                    raise ValueError("invalid size")
                request = json.loads(self.rfile.read(length))
                role, items = request["role"], request["items"]
                if role not in ("query", "passage") or not isinstance(items, list) or not 1 <= len(items) <= 24:
                    raise ValueError("invalid request")
                if any(not isinstance(item, str) or not 1 <= len(item) <= 1600 for item in items):
                    raise ValueError("invalid input")
                if role == "query" and len(items) != 1:
                    raise ValueError("expected one question")
                vectors = model.embed(items, role)
                data = json.dumps({"model": MODEL_ID, "vectors": vectors,
                                   **(model.thresholds(vectors[0]) if role == "query" else {})}).encode("utf8")
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    with HTTPServer(("127.0.0.1", opts.port), Handler) as server:
        print("Local embedding service ready", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
