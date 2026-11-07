# Приложения (не се индексират)

Тук се пазят приложенията на ингестирани документи — координатни регистри,
таблици и др., които са обемни и безполезни за семантично търсене. Те **не**
влизат в RAG базата (няма embeddings); пазят се само като референтен файл.

| Файл | Източник | Бележка |
| --- | --- | --- |
| `BG0000100_PS_11.pdf` | natura2000.egov.bg | оригиналният PDF (тяло + приложения) |
| `BG0000100_PS_11_appendices.txt` | същия PDF | само Приложение № 1 и № 2 (координатни регистри), ~111 000 знака |

Тялото на документа (Заповед № РД-354/31.03.2021) е индексирано в Supabase с
`document_id = BG0000100_PS_11` (14 chunk-а, `split: plain`).

## Копия в Google Drive (`knowledge/appendices`)

Папка: https://drive.google.com/drive/folders/1rD9cw0E_RO4GCf9oLFYaJqOhcjmxJHBn

| Файл в Drive | ID | Размер | Качен с |
| --- | --- | --- | --- |
| `BG0000100_PS_11.pdf` | `1YyWw8tQCechD_SCAmxrDnhiay-2NjC_X` | 562 374 B | `GOOGLEDRIVE_UPLOAD_FROM_URL` |
| `BG0000100_PS_11_appendices.txt` | `1GGuhkYR9dDktftwl2qLchEdWvasoNM6E` | 114 010 B | `GOOGLEDRIVE_CREATE_FILE_FROM_TEXT` |
| `BG0000100_PS_11_README.md` | `1Qf2iCNRQM3724lQlyq14tMKA2ulheFZe` | 981 B | `GOOGLEDRIVE_CREATE_FILE_FROM_TEXT` |
| `BG0000100 „Плаж Шкорпиловци“ — Приложения № 1 и № 2 (координатни регистри)` | `1KVixM_1jmknoRABm7Nh0IIb0Xsa-UzHQPmui3esF3Xs` | 54 072 B | `GOOGLEDOCS_CREATE_DOCUMENT` + `MOVE_FILE` |

Всички файлове са с общ префикс `BG0000100_PS_11` (от оригиналния ингест файл).
Линк към Doc-а има и в главната таблица
(`18JvK3vAPUm-J0h98Nl3OPGU5nm21vo9RKkumJYSwX08`, `Лист1!H6`).

## Рендиране на карта от координатен регистър

`make_boundary_map.py` превръща CSV с координати (`number,x,y`, UTM) в
самодостатъчен SVG с контура върху фонова карта. Само Python stdlib — без
`pyproj`, `shapely`, `matplotlib` или `PIL`.

```bash
# фон OpenStreetMap (по подразбиране)
python3 make_boundary_map.py --csv coords.csv --out map.svg

# сателит (Esri World Imagery), с повече място на изток за морето
python3 make_boundary_map.py --csv coords.csv --source esri --east-extra 0.25 --out map.svg

# само контур, без фон (без мрежа)
python3 make_boundary_map.py --csv coords.csv --source none --out map.svg
```

| Флаг | По подразбиране | Значение |
| --- | --- | --- |
| `--csv` | — | входен CSV с колони `number,x,y` (задължителен) |
| `--out` | `<csv>.svg` | изходен SVG |
| `--source` | `osm` | фон: `osm` \| `esri` \| `none` |
| `--zone` | `35` | UTM зона |
| `--south` | изкл. | южно полукълбо |
| `--width` | `1800` | целева ширина на картата в px |
| `--east-extra` | `0.20` | доп. рамка на изток (част от ширината на bbox) |
| `--margin` | `60` | рамка в px |
| `--closure-tol` | авто | толеранс за затваряне на контур, в метри |
| `--title` / `--subtitle` | авто | заглавие и подзаглавие |
| `--cache` | `$TMPDIR/karadere-map-tiles` | кеш за тайлове |

**Как работи:**

1. Чете CSV-то; приема и десетична точка, и десетична запетая.
2. Прожектира UTM → WGS84 със собствена inverse Transverse Mercator.
3. Разделя регистъра на **затворени контури** — контурът се затваря, когато
   поредната точка съвпадне с началната (напр. `#1999 → #1` = 0 m). Големите
   паузи *вътре* в контура не са разделител.
4. Изчислява площта: външните контури се събират, вложените (дупки) се вадят.
5. Тегли тайловете и ги вгражда като base64 `<image>`; полигонът се чертае в
   Web Mercator пикселно пространство.

**Забележка:** `qlmanage -t` прави квадратен thumbnail (добавя бяло поле
отдолу), затова за PNG рендер изрежи до реалната височина. За уеб ползвай
директно SVG-то — по-компактно е и не се нуждае от рендер.

Тестове: `python3 test_make_boundary_map.py` (херметични, без мрежа и ключове).
