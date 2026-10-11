# Иконка Майко

`icon-source.png` — полноразмерный прозрачный исходник, созданный встроенным `image_gen` (навык `imagegen`). Референс: `public/maiko/maiko-app-icon-v4.png`. Сохранены персонаж, палитра и синяя толстовка; пиксельные контуры заменены гладкими.

`prepare-icons.cjs` создаёт из него `icon.png` (1024 px) и `icon.ico` (16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px). Каждый размер вычисляется напрямую из исходника. ICO встраивается в EXE и дополнительно копируется в `win-unpacked/Maiko.ico`.

Промпт встроенного инструмента:

```text
Use case: identity-preserve. Asset type: transparent Windows/Electron application icon, square 1024x1024 PNG. Edit target: the provided Maiko squirrel mascot image. Primary request: redraw the SAME existing mascot as a very crisp, smoothly outlined high-resolution cartoon app icon; eliminate the pixel-art stair steps and low-resolution/blocky edges. Preserve identity, exact orange-brown squirrel coloring, two tall tufted ears, swept forelock, big brown eyes, cream cheeks and muzzle, reddish nose, friendly smile with the two front teeth, navy blue hoodie, same front-facing slight-three-quarter pose and composition. Keep head and shoulders, centered with both ears fully visible, compact silhouette filling about 88 percent of the square, readable at 16 and 32 pixels. Smooth clean dark outlines and simple controlled shading, same character design and expression, no extra detail or objects. Transparent background with actual alpha, not a checkerboard. No text, letters, badges, frames, shadows outside the silhouette or watermarks. Change only rendering quality and contour smoothness; do not redesign the character.
```

После сборки `refresh-built-icons.cjs` уведомляет Windows об изменении конкретных EXE через [SHChangeNotify](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shchangenotify). Это позволяет Проводнику обновить значок у файла, который пересобран по прежнему пути. Глобальный кэш значков не удаляется.
