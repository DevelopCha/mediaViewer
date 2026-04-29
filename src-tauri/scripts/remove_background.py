from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image, ImageOps, ImageStat
from rembg import new_session, remove


def pick_model(source: Path, requested_model: str) -> tuple[str, bool]:
    if requested_model == "anime":
        return "isnet-anime", False

    if requested_model == "real":
        return "isnet-general-use", False

    if requested_model == "bria":
        return "bria-rmbg", False

    if requested_model != "auto":
        return requested_model, requested_model not in {"isnet-anime"}

    try:
        with Image.open(source) as image:
            preview = image.convert("RGB")
            preview.thumbnail((96, 96))
            posterized = ImageOps.posterize(preview, 4)
            colors = posterized.getcolors(maxcolors=96 * 96) or []
            color_count = len(colors)
            saturation = ImageStat.Stat(preview.convert("HSV").getchannel("S")).mean[0]

        is_illustration = color_count <= 1400 and saturation >= 35
        if is_illustration:
            return "isnet-anime", False
    except Exception:
        pass

    return "isnet-general-use", False


def run_rembg(data: bytes, source: Path, requested_model: str) -> bytes:
    model_name, use_alpha_matting = pick_model(source, requested_model)
    fallback_model = "isnet-anime" if requested_model == "anime" else "isnet-general-use"

    for candidate_model in [model_name, fallback_model]:
        session = new_session(candidate_model)
        try:
            if use_alpha_matting:
                return remove(
                    data,
                    session=session,
                    alpha_matting=True,
                    alpha_matting_foreground_threshold=235,
                    alpha_matting_background_threshold=12,
                    alpha_matting_erode_size=4,
                    post_process_mask=True,
                )

            return remove(data, session=session, post_process_mask=True)
        except Exception:
            try:
                return remove(data, session=session, post_process_mask=True)
            except Exception:
                continue

    raise RuntimeError("All background-removal model attempts failed.")


def run_withoutbg(source: Path, target: Path) -> None:
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    from huggingface_hub import hf_hub_download
    from withoutbg import WithoutBG
    from withoutbg.exceptions import ModelNotFoundError
    from withoutbg.models import OpenSourceModel

    def safe_download_from_hf(self: OpenSourceModel, filename: str, model_name: str) -> Path:
        try:
            try:
                cached_path = hf_hub_download(
                    repo_id="withoutbg/focus",
                    filename=filename,
                    cache_dir=None,
                    local_files_only=True,
                )
                return Path(cached_path)
            except Exception:
                downloaded_path = hf_hub_download(
                    repo_id="withoutbg/focus",
                    filename=filename,
                    cache_dir=None,
                    local_files_only=False,
                )
                return Path(downloaded_path)
        except Exception as error:
            raise ModelNotFoundError(
                f"Failed to download {model_name} from Hugging Face: {error}\n"
                "You can manually download models from: https://huggingface.co/withoutbg/focus"
            ) from error

    OpenSourceModel._download_from_hf = safe_download_from_hf

    result = WithoutBG.opensource().remove_background(str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    result.save(target)


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit("Usage: remove_background.py <input> <output> [model]")

    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    requested_model = sys.argv[3] if len(sys.argv) > 3 else "auto"

    if requested_model == "withoutbg":
        try:
            run_withoutbg(source, target)
            return 0
        except Exception:
            requested_model = "real"

    data = source.read_bytes()
    result = run_rembg(data, source, requested_model)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
