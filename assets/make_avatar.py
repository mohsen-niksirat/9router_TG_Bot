import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def make_avatar():
    size = 1024
    img = Image.new("RGBA", (size, size), (8, 10, 20, 255))
    draw = ImageDraw.Draw(img)

    # 1. Cosmic Deep Gradient Background
    for y in range(size):
        ratio = y / size
        r = int(7 + ratio * 15)
        g = int(9 + ratio * 15)
        b = int(22 + ratio * 45)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # 2. Ambient glowing orbs & Cyber Nebula
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)

    # Electric Violet Orb (top right)
    for r in range(480, 0, -12):
        alpha = int(45 * (1 - r / 480))
        gdraw.ellipse([750 - r, 280 - r, 750 + r, 280 + r], fill=(139, 92, 246, alpha))

    # Cyan / Emerald Neon Orb (bottom left)
    for r in range(460, 0, -12):
        alpha = int(45 * (1 - r / 460))
        gdraw.ellipse([270 - r, 720 - r, 270 + r, 720 + r], fill=(6, 182, 212, alpha))

    # Subtle grid lines
    for x in range(0, size, 64):
        gdraw.line([(x, 0), (x, size)], fill=(255, 255, 255, 8), width=1)
    for y in range(0, size, 64):
        gdraw.line([(0, y), (size, y)], fill=(255, 255, 255, 8), width=1)

    # Concentric orbital rings around center
    cx, cy = 512, 440
    for rad, stroke, col in [
        (400, 1, (139, 92, 246, 30)),
        (330, 2, (6, 182, 212, 45)),
        (260, 1, (255, 255, 255, 30)),
        (190, 2, (139, 92, 246, 70)),
    ]:
        gdraw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=col, width=stroke)

    img = Image.alpha_composite(img, glow)

    # 3. Router Network Web / Constellation Lines
    net_overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ndraw = ImageDraw.Draw(net_overlay)

    # Node positions (satellites orbiting router hub)
    satellites = [
        {"angle": -90, "dist": 260, "name": "GEMINI", "col": (66, 133, 244)},
        {"angle": -30, "dist": 270, "name": "GROQ", "col": (245, 101, 101)},
        {"angle": 35, "dist": 260, "name": "DEEPSEEK", "col": (59, 130, 246)},
        {"angle": 105, "dist": 270, "name": "OPENAI", "col": (16, 185, 129)},
        {"angle": 160, "dist": 260, "name": "OPENROUTER", "col": (168, 85, 247)},
        {"angle": 215, "dist": 270, "name": "FREEAI", "col": (236, 72, 153)},
    ]

    fonts_dir = "C:\\Windows\\Fonts"
    try:
        f_node = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 14)
        f_brand = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 68)
        f_tag = ImageFont.truetype(os.path.join(fonts_dir, "segoeui.ttf"), 26)
        f_core = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 48)
        f_hub_sub = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 15)
    except Exception:
        f_node = ImageFont.load_default()
        f_brand = f_node
        f_tag = f_node
        f_core = f_node
        f_hub_sub = f_node

    # Draw rays from central hub to nodes
    for sat in satellites:
        rad = math.radians(sat["angle"])
        nx = int(cx + sat["dist"] * math.cos(rad))
        ny = int(cy + sat["dist"] * math.sin(rad))
        sat["x"] = nx
        sat["y"] = ny
        # Glow ray
        ndraw.line([(cx, cy), (nx, ny)], fill=sat["col"] + (110,), width=3)
        # Dynamic packet dashes
        px = int(cx + sat["dist"] * 0.55 * math.cos(rad))
        py = int(cy + sat["dist"] * 0.55 * math.sin(rad))
        ndraw.ellipse([px - 6, py - 6, px + 6, py + 6], fill=(255, 255, 255, 240))

    # Connect outer satellites to form a perimeter mesh
    for i in range(len(satellites)):
        p1 = satellites[i]
        p2 = satellites[(i + 1) % len(satellites)]
        ndraw.line([(p1["x"], p1["y"]), (p2["x"], p2["y"])], fill=(139, 92, 246, 50), width=2)

    # 4. Central Router Hub Hexagon / Shield
    hub_radius = 120
    # Outer Glow behind hub
    for gr in range(40, 0, -3):
        alpha = int(50 * (1 - gr / 40))
        ndraw.ellipse([cx - hub_radius - gr, cy - hub_radius - gr, cx + hub_radius + gr, cy + hub_radius + gr], fill=(139, 92, 246, alpha))

    # Hub background circle
    ndraw.ellipse([cx - hub_radius, cy - hub_radius, cx + hub_radius, cy + hub_radius], fill=(15, 20, 38, 245), outline=(6, 182, 212, 240), width=4)
    # Inner accent ring
    ndraw.ellipse([cx - hub_radius + 14, cy - hub_radius + 14, cx + hub_radius - 14, cy + hub_radius - 14], outline=(139, 92, 246, 180), width=2)

    # Central Router Emblem (Stylized "9R" + Router Switch Icon)
    # Draw router antenna / wave arcs
    ndraw.arc([cx - 40, cy - 70, cx + 40, cy + 10], start=210, end=330, fill=(6, 182, 212, 240), width=4)
    ndraw.arc([cx - 55, cy - 85, cx + 55, cy + 25], start=210, end=330, fill=(139, 92, 246, 200), width=3)
    
    # "9R" Core Text
    core_text = "9R"
    bbox = ndraw.textbbox((0, 0), core_text, font=f_core)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # Shadow
    ndraw.text((cx - tw // 2 + 2, cy - th // 2 - 2), core_text, fill=(6, 182, 212, 100), font=f_core)
    ndraw.text((cx - tw // 2, cy - th // 2 - 4), core_text, fill=(255, 255, 255, 255), font=f_core)

    # "SMART ROUTER" text badge in hub
    sub_text = "MULTI-AI"
    sbbox = ndraw.textbbox((0, 0), sub_text, font=f_hub_sub)
    stw = sbbox[2] - sbbox[0]
    ndraw.rounded_rectangle([cx - stw // 2 - 12, cy + 42, cx + stw // 2 + 12, cy + 66], radius=10, fill=(6, 182, 212, 40), outline=(6, 182, 212, 180), width=1)
    ndraw.text((cx - stw // 2, cy + 45), sub_text, fill=(6, 182, 212, 255), font=f_hub_sub)

    # 5. Draw Satellite Badges
    for sat in satellites:
        sx, sy = sat["x"], sat["y"]
        sw, sh = 96, 38
        # Shadow
        ndraw.rounded_rectangle([sx - sw//2 - 2, sy - sh//2 - 2, sx + sw//2 + 2, sy + sh//2 + 2], radius=19, fill=sat["col"] + (40,), outline=sat["col"] + (190,), width=2)
        ndraw.rounded_rectangle([sx - sw//2, sy - sh//2, sx + sw//2, sy + sh//2], radius=18, fill=(12, 16, 30, 240))
        # Small colored LED dot
        ndraw.ellipse([sx - sw//2 + 12, sy - 4, sx - sw//2 + 20, sy + 4], fill=sat["col"] + (255,))
        # Text
        ndraw.text((sx - sw//2 + 26, sy - 10), sat["name"], fill=(240, 245, 255, 255), font=f_node)

    img = Image.alpha_composite(img, net_overlay)

    # 6. Bottom Typography & Brand Plate
    draw = ImageDraw.Draw(img)
    brand_text = "9ROUTER AI"
    bbox = draw.textbbox((0, 0), brand_text, font=f_brand)
    bw = bbox[2] - bbox[0]
    # Neon cyan drop shadow
    draw.text((cx - bw // 2 + 2, 792), brand_text, fill=(6, 182, 212, 80), font=f_brand)
    draw.text((cx - bw // 2, 790), brand_text, fill=(255, 255, 255, 255), font=f_brand)

    # Category Pill
    pill_text = "INTELLIGENT MULTI-PROVIDER POOL & FAILOVER"
    pbbox = draw.textbbox((0, 0), pill_text, font=f_node)
    pw = pbbox[2] - pbbox[0]
    draw.rounded_rectangle([cx - pw//2 - 18, 880, cx + pw//2 + 18, 914], radius=17, fill=(139, 92, 246, 35), outline=(139, 92, 246, 180), width=1)
    draw.text((cx - pw//2, 888), pill_text, fill=(196, 181, 253, 255), font=f_node)

    tag_text = "Round-Robin • Smart Router • Priority Fallback"
    tbbox = draw.textbbox((0, 0), tag_text, font=f_tag)
    tw = tbbox[2] - tbbox[0]
    draw.text((cx - tw // 2, 930), tag_text, fill=(148, 163, 184, 255), font=f_tag)

    # Outer decorative frame
    draw.rounded_rectangle([20, 20, size - 20, size - 20], radius=40, outline=(139, 92, 246, 90), width=2)
    draw.rounded_rectangle([26, 26, size - 26, size - 26], radius=36, outline=(6, 182, 212, 50), width=1)

    os.makedirs("C:/Users/MOHSEN/Desktop/Github Projects/9router_TG_Bot/assets", exist_ok=True)
    out_path = "C:/Users/MOHSEN/Desktop/Github Projects/9router_TG_Bot/assets/avatar.jpg"
    final = img.convert("RGB")
    final.save(out_path, quality=96)
    
    # Also save to artifact directory for immediate user visual preview
    art_dir = "C:/Users/MOHSEN/.gemini/antigravity/brain/17f82db0-804e-4602-a8f8-a145d4c97b42"
    os.makedirs(art_dir, exist_ok=True)
    final.save(os.path.join(art_dir, "avatar.jpg"), quality=96)
    print("Avatar generated successfully at:", out_path)

if __name__ == "__main__":
    make_avatar()
