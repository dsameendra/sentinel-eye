"""Checks that a missing optional AI-enhancer dependency (PIL/torch/cv2/realesrgan/gfpgan — none of which
are in the Docker image by design, see the Dockerfile's own comment) surfaces a clear, actionable job error
instead of a raw "ModuleNotFoundError: No module named 'X'", which reads as a bug rather than the
documented, expected state of a Docker deployment. No real AI dependencies needed to run this: the missing
import is simulated.

   .venv/bin/python3 tools/test_enhance_ai.py
"""
import builtins
import sys
import time

sys.path.insert(0, "app")
import enhance_ai

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def with_import_blocked(module_name, fn):
    """Runs fn() with `import <module_name>` (and `from <module_name> import ...`) raising
    ModuleNotFoundError, as if it were genuinely not installed — without needing to actually uninstall it."""
    real_import = builtins.__import__

    def fake_import(name, *a, **kw):
        if name == module_name or name.startswith(module_name + "."):
            raise ModuleNotFoundError(f"No module named {module_name!r}", name=module_name)
        return real_import(name, *a, **kw)

    builtins.__import__ = fake_import
    try:
        fn()
    finally:
        builtins.__import__ = real_import


def missing_pil_gives_a_clear_job_error():
    job_id = "test-missing-pil"
    with enhance_ai._jobs_lock:
        enhance_ai._jobs[job_id] = {"state": "queued", "progress": "Queued…", "error": None, "done": False}

    with_import_blocked("PIL", lambda: enhance_ai._run(job_id, ["irrelevant"], "sharpen", 1, "2026-01-01T00:00:00Z"))

    job = enhance_ai.get_job(job_id)
    check("job ends in error state", job["state"] == "error", job)
    check("error names the missing module, not a raw traceback",
          "PIL" in job["error"] and "ModuleNotFoundError" not in job["error"], job["error"])
    check("error explains this is a Docker limitation, not a bug",
          "Docker" in job["error"] and "README" in job["error"], job["error"])


def main():
    missing_pil_gives_a_clear_job_error()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
