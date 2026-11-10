"""Génère les icônes de SwiftPad (aucune ressource externe).

Dessin simple : feuille aux coins arrondis, pli en haut à droite, trois
lignes de texte et un éclair (« swift »). Usage : python scripts/make-icons.py
Sortie : src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png + icon.ico
"""
import os
import sys
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src-tauri', 'icons')
BASE = 1024


def draw(size: int) -> Image.Image:
    s = BASE
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Fond : carré arrondi bleu.
    d.rounded_rectangle((40, 40, s - 40, s - 40), radius=200, fill=(37, 99, 235, 255))
    # Feuille blanche avec pli.
    left, top, right, bottom, fold = 250, 170, 774, 854, 150
    d.polygon([(left, top), (right - fold, top), (right, top + fold), (right, bottom), (left, bottom)], fill=(255, 255, 255, 255))
    d.polygon([(right - fold, top), (right - fold, top + fold), (right, top + fold)], fill=(191, 219, 254, 255))
    # Lignes de texte.
    for i, w in enumerate((380, 300, 340, 220)):
        y = 380 + i * 100
        d.rounded_rectangle((left + 70, y, left + 70 + w, y + 40), radius=20, fill=(148, 163, 184, 255))
    # Éclair.
    bolt = [(600, 470), (500, 690), (575, 690), (530, 880), (720, 620), (640, 620), (700, 470)]
    d.polygon(bolt, fill=(250, 204, 21, 255), outline=(202, 138, 4, 255))
    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for name, size in (('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)):
        draw(size).save(os.path.join(OUT, name))
    big = draw(256)
    big.save(os.path.join(OUT, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('icônes écrites dans', os.path.normpath(OUT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
