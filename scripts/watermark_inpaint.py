#!/usr/bin/env python3
"""
Antigravity Watermark Remover Inpainting Engine
Supports:
1. High-quality Image Inpainting (Telea / Navier-Stokes) with alpha channel support.
2. Moving Watermark Tracking and Inpainting across video frames.
"""

import sys
import os
import json
import argparse
import numpy as np

try:
    import cv2
except ImportError:
    print(json.dumps({"success": False, "error": "OpenCV (cv2) is not installed in Python environment."}), file=sys.stderr)
    sys.exit(1)


def inpaint_image(input_path, output_path, x, y, width, height, method="telea", inpaint_radius=3, feather=2):
    """
    Inpaint a rectangular region on a static image.
    Supports JPG, PNG, WEBP, BMP. Preserves original dimensions and alpha channels.
    """
    if not os.path.exists(input_path):
        return {"success": False, "error": f"Input file does not exist: {input_path}"}

    img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return {"success": False, "error": "Could not decode input image."}

    img_h, img_w = img.shape[:2]

    # Convert coordinates if normalized (0.0 - 1.0)
    if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 and width <= 1.0 and height <= 1.0:
        px = int(round(x * img_w))
        py = int(round(y * img_h))
        pw = int(round(width * img_w))
        ph = int(round(height * img_h))
    else:
        px = int(round(x))
        py = int(round(y))
        pw = int(round(width))
        ph = int(round(height))

    # Clamp coordinates to image boundaries
    px = max(0, min(px, img_w - 1))
    py = max(0, min(py, img_h - 1))
    pw = max(1, min(pw, img_w - px))
    ph = max(1, min(ph, img_h - py))

    # Create binary mask (uint8, 0 for keep, 255 for inpaint)
    mask = np.zeros((img_h, img_w), dtype=np.uint8)
    mask[py:py + ph, px:px + pw] = 255

    # Optional feather/dilation for seamless blending around edges
    if feather > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (feather * 2 + 1, feather * 2 + 1))
        mask = cv2.dilate(mask, kernel, iterations=1)

    # Inpaint flags
    flag = cv2.INPAINT_TELEA if method.lower() == "telea" else cv2.INPAINT_NS

    # Handle different channel configurations
    has_alpha = False
    alpha_channel = None

    if len(img.shape) == 2:
        # Grayscale
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        inpainted_bgr = cv2.inpaint(bgr, mask, inpaint_radius, flag)
        res = cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2GRAY)
    elif len(img.shape) == 3 and img.shape[2] == 4:
        # BGRA with Alpha Channel
        has_alpha = True
        bgr = img[:, :, :3]
        alpha_channel = img[:, :, 3]
        inpainted_bgr = cv2.inpaint(bgr, mask, inpaint_radius, flag)
        # Reconstruct BGRA
        res = np.dstack((inpainted_bgr, alpha_channel))
    else:
        # Standard BGR
        bgr = img[:, :, :3] if len(img.shape) == 3 else img
        res = cv2.inpaint(bgr, mask, inpaint_radius, flag)

    # Ensure output directory exists
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    # Save with appropriate high-quality compression parameters
    ext = os.path.splitext(output_path)[1].lower()
    encode_params = []
    if ext in [".jpg", ".jpeg"]:
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, 95]
        # If original had alpha, convert to 3 channels for JPEG
        if len(res.shape) == 3 and res.shape[2] == 4:
            res = res[:, :, :3]
    elif ext == ".png":
        encode_params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
    elif ext == ".webp":
        encode_params = [cv2.IMWRITE_WEBP_QUALITY, 95]

    write_ok = cv2.imwrite(output_path, res, encode_params)
    if not write_ok:
        return {"success": False, "error": f"Failed to write inpainted image to: {output_path}"}

    return {
        "success": True,
        "width": img_w,
        "height": img_h,
        "box": {"x": px, "y": py, "width": pw, "height": ph},
        "method": method,
        "outputPath": output_path
    }


def create_tracker():
    """Create OpenCV Tracker with robust fallback across OpenCV versions."""
    try:
        if hasattr(cv2, "TrackerCSRT_create"):
            return cv2.TrackerCSRT_create()
        if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerCSRT_create"):
            return cv2.legacy.TrackerCSRT_create()
        if hasattr(cv2, "TrackerKCF_create"):
            return cv2.TrackerKCF_create()
        if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerKCF_create"):
            return cv2.legacy.TrackerKCF_create()
        if hasattr(cv2, "TrackerMIL_create"):
            return cv2.TrackerMIL_create()
        if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerMIL_create"):
            return cv2.legacy.TrackerMIL_create()
    except Exception:
        pass
    return None


def inpaint_video_tracking(input_path, output_path, x, y, width, height, method="telea", inpaint_radius=3):
    """
    Inpaint a moving or static watermark across all video frames using object tracking.
    """
    if not os.path.exists(input_path):
        return {"success": False, "error": f"Input video does not exist: {input_path}"}

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return {"success": False, "error": "Could not open video file for processing."}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # Convert coordinates if normalized
    if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 and width <= 1.0 and height <= 1.0:
        px = int(round(x * vw))
        py = int(round(y * vh))
        pw = int(round(width * vw))
        ph = int(round(height * vh))
    else:
        px = int(round(x))
        py = int(round(y))
        pw = int(round(width))
        ph = int(round(height))

    px = max(0, min(px, vw - 1))
    py = max(0, min(py, vh - 1))
    pw = max(1, min(pw, vw - px))
    ph = max(1, min(ph, vh - py))

    # Read first frame
    ret, first_frame = cap.read()
    if not ret or first_frame is None:
        cap.release()
        return {"success": False, "error": "Could not read the first video frame."}

    # Initialize tracker
    tracker = create_tracker()
    init_box = (px, py, pw, ph)
    tracker_ready = False
    if tracker is not None:
        try:
            tracker.init(first_frame, init_box)
            tracker_ready = True
        except Exception:
            tracker_ready = False

    # Video writer for raw video stream (MP4 / H264 / mp4v)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    out = cv2.VideoWriter(output_path, fourcc, fps, (vw, vh))
    if not out.isOpened():
        cap.release()
        return {"success": False, "error": f"Failed to initialize video writer: {output_path}"}

    flag = cv2.INPAINT_TELEA if method.lower() == "telea" else cv2.INPAINT_NS
    current_box = [px, py, pw, ph]
    frame_idx = 0

    try:
        while True:
            if frame_idx == 0:
                frame = first_frame
            else:
                ret, frame = cap.read()
                if not ret or frame is None:
                    break

            # Update tracker if active
            if tracker_ready and frame_idx > 0:
                try:
                    success, tracked_box = tracker.update(frame)
                    if success:
                        tx, ty, tw, th = [int(v) for v in tracked_box]
                        # Sanity check: bounding box shouldn't explode or collapse
                        if tw > 0 and th > 0 and tx >= 0 and ty >= 0 and tx + tw <= vw and ty + th <= vh:
                            current_box = [tx, ty, tw, th]
                except Exception:
                    pass

            # Create mask for this frame
            cur_x, cur_y, cur_w, cur_h = current_box
            mask = np.zeros((vh, vw), dtype=np.uint8)
            mask[cur_y:cur_y + cur_h, cur_x:cur_x + cur_w] = 255
            # Dilate mask slightly for smooth edges
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.dilate(mask, kernel, iterations=1)

            # Inpaint frame
            inpainted_frame = cv2.inpaint(frame, mask, inpaint_radius, flag)
            out.write(inpainted_frame)
            frame_idx += 1

    finally:
        cap.release()
        out.release()

    return {
        "success": True,
        "framesProcessed": frame_idx,
        "width": vw,
        "height": vh,
        "fps": fps,
        "outputPath": output_path
    }


def main():
    parser = argparse.ArgumentParser(description="Watermark Inpainting Engine")
    parser.add_argument("--mode", required=True, choices=["image", "video_track", "video_inpaint"], help="Processing mode")
    parser.add_argument("--input", required=True, help="Path to input media file")
    parser.add_argument("--output", required=True, help="Path to output media file")
    parser.add_argument("--x", type=float, required=True, help="Watermark X coordinate")
    parser.add_argument("--y", type=float, required=True, help="Watermark Y coordinate")
    parser.add_argument("--width", type=float, required=True, help="Watermark Width")
    parser.add_argument("--height", type=float, required=True, help="Watermark Height")
    parser.add_argument("--method", default="telea", choices=["telea", "ns"], help="Inpainting algorithm")
    parser.add_argument("--radius", type=int, default=3, help="Inpainting neighborhood radius")
    parser.add_argument("--feather", type=int, default=2, help="Mask border feathering/dilation")

    args = parser.parse_args()

    if args.mode == "image":
        result = inpaint_image(
            input_path=args.input,
            output_path=args.output,
            x=args.x,
            y=args.y,
            width=args.width,
            height=args.height,
            method=args.method,
            inpaint_radius=args.radius,
            feather=args.feather
        )
    else:
        result = inpaint_video_tracking(
            input_path=args.input,
            output_path=args.output,
            x=args.x,
            y=args.y,
            width=args.width,
            height=args.height,
            method=args.method,
            inpaint_radius=args.radius
        )

    print(json.dumps(result))
    if not result.get("success"):
        sys.exit(1)


if __name__ == "__main__":
    main()
