import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def make_banner():
    width = 1280
    height = 720
    
    # 1. Base Dark Canvas
    img = Image.new("RGBA", (width, height), (8, 10, 22, 255))
    draw = ImageDraw.Draw(img)

    # Cosmic gradient background
    for y in range(height):
        ratio = y / height
        r = int(7 + ratio * 10)
        g = int(9 + ratio * 12)
        b = int(22 + ratio * 28)
        draw.line([(0, y), (width, y)], fill=(r, g, b, 255))

    # 2. Glowing Orbs
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)

    # Electric Violet orb (top left)
    for rad in range(360, 0, -8):
        alpha = int(32 * (1 - rad / 360))
        glow_draw.ellipse([200 - rad, 160 - rad, 200 + rad, 160 + rad], fill=(139, 92, 246, alpha))

    # Neon Cyan orb (bottom right / behind avatar)
    for rad in range(380, 0, -8):
        alpha = int(36 * (1 - rad / 380))
        glow_draw.ellipse([980 - rad, 360 - rad, 980 + rad, 360 + rad], fill=(6, 182, 212, alpha))

    # Emerald glow (bottom center)
    for rad in range(260, 0, -8):
        alpha = int(25 * (1 - rad / 260))
        glow_draw.ellipse([540 - rad, 650 - rad, 540 + rad, 650 + rad], fill=(16, 185, 129, alpha))

    # Subtle modern grid
    for x in range(0, width, 50):
        glow_draw.line([(x, 0), (x, height)], fill=(255, 255, 255, 6))
    for y in range(0, height, 50):
        glow_draw.line([(0, y), (width, y)], fill=(255, 255, 255, 6))

    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # Fonts
    fonts_dir = "C:\\Windows\\Fonts"
    try:
        f_title = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 58)
        f_sub = ImageFont.truetype(os.path.join(fonts_dir, "segoeui.ttf"), 22)
        f_desc = ImageFont.truetype(os.path.join(fonts_dir, "segoeui.ttf"), 16)
        f_badge = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 13)
        f_feat_title = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 16)
        f_feat_sub = ImageFont.truetype(os.path.join(fonts_dir, "segoeui.ttf"), 14)
        f_btn = ImageFont.truetype(os.path.join(fonts_dir, "segoeuib.ttf"), 18)
        f_btn_sub = ImageFont.truetype(os.path.join(fonts_dir, "segoeui.ttf"), 14)
    except Exception:
        f_title = ImageFont.load_default()
        f_sub = f_title
        f_desc = f_title
        f_badge = f_title
        f_feat_title = f_title
        f_feat_sub = f_title
        f_btn = f_title
        f_btn_sub = f_title

    # 3. Top Category Pill
    badge_x = 75
    badge_y = 60
    draw.rounded_rectangle([badge_x, badge_y, badge_x + 300, badge_y + 32], radius=16, fill=(139, 92, 246, 35), outline=(139, 92, 246, 160), width=1)
    draw.text((badge_x + 18, badge_y + 7), "MULTI-AI GATEWAY • SERVERLESS ENGINE", fill=(196, 181, 253, 255), font=f_badge)

    # 4. Main Title: "9Router TG Bot"
    title_y = badge_y + 44
    draw.text((badge_x + 3, title_y + 3), "9Router TG Bot", fill=(6, 182, 212, 70), font=f_title)
    draw.text((badge_x, title_y), "9Router TG Bot", fill=(255, 255, 255, 255), font=f_title)

    # Tagline
    tagline_y = title_y + 74
    draw.text((badge_x, tagline_y), "Intelligent Multi-Provider AI Router & Telegram Mini App", fill=(186, 230, 253, 255), font=f_sub)

    desc_y = tagline_y + 34
    draw.text((badge_x, desc_y), "Pool API keys across Gemini, Groq, DeepSeek, OpenAI & custom endpoints with zero downtime.", fill=(148, 163, 184, 255), font=f_desc)

    # 5. Features Grid (2x2 cards: x: 75 to 695)
    features = [
        ("FAILOVER & 429 SHIELD", "Round-Robin, Smart Router &\nauto-fallback across keys & providers", (139, 92, 246)),
        ("ENCRYPTED KEY VAULT", "Per-user at-rest key encryption;\nzero shared keys, isolated security", (16, 185, 129)),
        ("CUSTOM COMBOS & POOLS", "Mix multiple providers in one combo\nwith customizable model fallback chains", (6, 182, 212)),
        ("VISION & TELEGRAM MINI APP", "Full SPA Web App with multimodal chat,\nimage understanding & token analytics", (236, 72, 153)),
    ]

    cw = 300
    ch = 100
    gap_x = 16
    gap_y = 16
    start_feat_y = desc_y + 40

    for idx, (ftitle, fdesc, col) in enumerate(features):
        col_idx = idx % 2
        row_idx = idx // 2
        fx = badge_x + col_idx * (cw + gap_x)
        fy = start_feat_y + row_idx * (ch + gap_y)

        card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        cdraw = ImageDraw.Draw(card)
        cdraw.rounded_rectangle([0, 0, cw, ch], radius=14, fill=(15, 20, 36, 230), outline=col + (100,), width=1)
        
        # Left colored accent bar
        cdraw.rounded_rectangle([0, 0, 4, ch], radius=2, fill=col + (230,))
        
        # Small colored pill / circle
        cdraw.ellipse([16, 16, 24, 24], fill=col + (255,))
        cdraw.text((32, 12), ftitle, fill=(240, 245, 255, 255), font=f_feat_title)
        cdraw.multiline_text((16, 42), fdesc, fill=(148, 163, 184, 255), font=f_feat_sub, spacing=3)
        
        img.alpha_composite(card, (fx, fy))

    # 6. Bottom Action Bar
    btn_y = start_feat_y + 2 * (ch + gap_y) + 16
    draw.rounded_rectangle([badge_x, btn_y, badge_x + 310, btn_y + 44], radius=22, fill=(139, 92, 246, 220), outline=(196, 181, 253, 240), width=1)
    draw.text((badge_x + 24, btn_y + 11), "Telegram Mini App Ready", fill=(255, 255, 255, 255), font=f_btn)
    
    # Official URL / Note
    draw.text((badge_x + 330, btn_y + 13), "Web App: app9029829582.tgcloud.ai   •   Powered by tgcloud", fill=(148, 163, 184, 240), font=f_btn_sub)

    # 7. Right Side: 3D Glass Mockup of Avatar Image
    avatar_path = "C:/Users/MOHSEN/Desktop/Github Projects/9router_TG_Bot/assets/avatar.jpg"
    if os.path.exists(avatar_path):
        av_img = Image.open(avatar_path).convert("RGBA")
        av_size = 460
        av_img = av_img.resize((av_size, av_size), Image.Resampling.LANCZOS)

        # Rounded mask for avatar
        mask = Image.new("L", (av_size, av_size), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rounded_rectangle([0, 0, av_size, av_size], radius=44, fill=255)

        av_x = 740
        av_y = 125

        # Glowing frame under avatar
        glow_box = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        gdraw = ImageDraw.Draw(glow_box)
        for g_rad in range(35, 0, -3):
            g_alpha = int(40 * (1 - g_rad / 35))
            gdraw.rounded_rectangle([av_x - g_rad, av_y - g_rad, av_x + av_size + g_rad, av_y + av_size + g_rad], radius=44 + g_rad, outline=(6, 182, 212, g_alpha), width=2)
        img = Image.alpha_composite(img, glow_box)

        # Paste avatar with mask
        img.paste(av_img, (av_x, av_y), mask)

        # Crisp glassmorphic border on top of avatar
        top_draw = ImageDraw.Draw(img)
        top_draw.rounded_rectangle([av_x, av_y, av_x + av_size, av_y + av_size], radius=44, outline=(6, 182, 212, 190), width=2)

        # Floating badge over avatar bottom
        tag_w = 260
        tag_h = 40
        tag_x = av_x + (av_size - tag_w) // 2
        tag_y = av_y + av_size - 20
        top_draw.rounded_rectangle([tag_x, tag_y, tag_x + tag_w, tag_y + tag_h], radius=20, fill=(10, 14, 28, 245), outline=(139, 92, 246, 180), width=1)
        
        # Tag text
        tag_text = "9ROUTER CORE v2.0 • ACTIVE"
        tbbox = top_draw.textbbox((0, 0), tag_text, font=f_badge)
        tw = tbbox[2] - tbbox[0]
        top_draw.text((tag_x + (tag_w - tw)//2, tag_y + 11), tag_text, fill=(6, 182, 212, 255), font=f_badge)

    out_path = "C:/Users/MOHSEN/Desktop/Github Projects/9router_TG_Bot/assets/banner.jpg"
    final = img.convert("RGB")
    final.save(out_path, quality=96)
    
    # Save to artifact directory as well
    art_dir = "C:/Users/MOHSEN/.gemini/antigravity/brain/17f82db0-804e-4602-a8f8-a145d4c97b42"
    final.save(os.path.join(art_dir, "banner.jpg"), quality=96)
    print("Banner generated successfully at:", out_path)

if __name__ == "__main__":
    make_banner()
