import io
import pytest
from PIL import Image
from app.images import optimize_to_webp, is_webp


def _create_image(format="JPEG", size=(800, 600), color=(255, 120, 40)):
    buf = io.BytesIO()
    img = Image.new("RGB", size, color=color)
    img.save(buf, format=format)
    return buf.getvalue()


def test_is_webp():
    # Not webp
    jpeg_data = _create_image("JPEG")
    assert not is_webp(jpeg_data)

    # Convert to webp
    webp_data, mime = optimize_to_webp(jpeg_data, quality=95)
    assert mime == "image/webp"
    assert is_webp(webp_data)


def test_jpeg_to_webp_conversion():
    jpeg_data = _create_image("JPEG", size=(1200, 900))
    webp_data, mime = optimize_to_webp(jpeg_data, quality=95)

    assert mime == "image/webp"
    assert len(webp_data) > 0
    assert is_webp(webp_data)

    # Open with PIL and check format and dimensions
    with Image.open(io.BytesIO(webp_data)) as im:
        assert im.format == "WEBP"
        assert im.size == (1200, 900)


def test_png_to_webp_conversion():
    buf = io.BytesIO()
    img = Image.new("RGBA", (640, 480), color=(10, 200, 150, 200))
    img.save(buf, format="PNG")
    png_data = buf.getvalue()

    webp_data, mime = optimize_to_webp(png_data, quality=95)
    assert mime == "image/webp"
    assert is_webp(webp_data)

    with Image.open(io.BytesIO(webp_data)) as im:
        assert im.format == "WEBP"
        assert im.size == (640, 480)


def test_downscale_large_image():
    # 3200x1600 image should be scaled down to max dimension 2560
    large_jpeg = _create_image("JPEG", size=(3200, 1600))
    webp_data, mime = optimize_to_webp(large_jpeg, max_dimension=2560, quality=95)

    assert mime == "image/webp"
    with Image.open(io.BytesIO(webp_data)) as im:
        assert im.format == "WEBP"
        assert im.width == 2560
        assert im.height == 1280


def test_non_image_fallback():
    # Corrupt or non-image data should be returned unchanged without raising an unhandled exception
    dummy_data = b"NOT_AN_IMAGE_CONTENT_123456789"
    result, mime = optimize_to_webp(dummy_data)
    assert result == dummy_data
    assert mime == "image/jpeg"
