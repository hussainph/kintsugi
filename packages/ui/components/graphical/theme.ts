import type { ThemeDocument } from './lib/theme-model';

// Exact current project snapshot. Keep the internal theme identity for preview behavior.
export const theme: ThemeDocument = {
  "schemaVersion": 2,
  "name": "Kintsugi",
  "theme": {
    "name": "Charter",
    "text": {
      "l": {
        "size": 23.338,
        "lineHeight": 31.117
      },
      "m": {
        "size": 15.559,
        "lineHeight": 23.338
      },
      "s": {
        "size": 13.614,
        "lineHeight": 19.448
      },
      "xl": {
        "size": 35.007,
        "lineHeight": 38.897
      },
      "xs": {
        "size": 11.669,
        "lineHeight": 15.559
      },
      "xxl": {
        "size": 46.676,
        "lineHeight": 50.566
      },
      "xxs": {
        "size": 9.724,
        "lineHeight": 13.614
      }
    },
    "fonts": {
      "ui": {
        "family": "\"Timeless Sans\", sans-serif",
        "weights": {
          "heavy": 600,
          "medium": 500,
          "regular": 400
        }
      },
      "data": {
        "family": "\"Sidebar Geist Mono\", monospace",
        "weights": {
          "heavy": 600,
          "medium": 500,
          "regular": 400
        }
      },
      "brand": {
        "family": "\"LT Superior Serif\", Georgia, serif",
        "weights": {
          "heavy": 700,
          "medium": 500,
          "regular": 400
        }
      },
      "editorial": {
        "family": "\"LT Superior Serif\", Georgia, serif",
        "weights": {
          "heavy": 700,
          "medium": 500,
          "regular": 400
        }
      }
    },
    "border": {
      "l": 1.26,
      "m": 0.6,
      "s": 0.5837239583333333,
      "none": 0
    },
    "colors": {
      "dark": {
        "error": "#ee9991",
        "color-1": "#0a0a0a",
        "color-2": "#779575",
        "color-3": "#c3b58f",
        "color-4": "#b0a0c0",
        "success": "#88cbaa",
        "warning": "#ddbc74",
        "neutral-1": "#191919",
        "neutral-2": "#202020",
        "neutral-3": "#282828",
        "neutral-4": "#363636",
        "neutral-5": "#494949",
        "neutral-6": "#757575",
        "neutral-7": "#a7a7a7",
        "neutral-8": "#c8c8c8",
        "neutral-9": "#e0e0e0",
        "neutral-10": "#f9f9f9"
      },
      "light": {
        "error": "#b34846",
        "color-1": "#0a0a0a",
        "color-2": "#c2d3b8",
        "color-3": "#e2d7bd",
        "color-4": "#c8bbd5",
        "success": "#247052",
        "warning": "#926318",
        "neutral-1": "#ffffff",
        "neutral-2": "#f9f9f9",
        "neutral-3": "#f0f0f0",
        "neutral-4": "#e0e0e0",
        "neutral-5": "#cfcfcf",
        "neutral-6": "#a1a1a1",
        "neutral-7": "#737373",
        "neutral-8": "#525252",
        "neutral-9": "#333333",
        "neutral-10": "#1f1f1f"
      }
    },
    "radius": {
      "l": 15,
      "m": 10,
      "s": 4.67,
      "xl": 25,
      "xs": 2,
      "full": 9999,
      "zero": 0
    },
    "shadows": {
      "l": {
        "x": 0,
        "y": 16,
        "blur": 40,
        "color": {
          "dark": "neutral-1",
          "light": "neutral-10"
        },
        "spread": 0,
        "opacity": 30
      },
      "m": {
        "x": 0,
        "y": 8,
        "blur": 24,
        "color": {
          "dark": "neutral-1",
          "light": "neutral-10"
        },
        "spread": 0,
        "opacity": 20
      },
      "s": {
        "x": 0,
        "y": 2,
        "blur": 4,
        "color": {
          "dark": "neutral-1",
          "light": "neutral-10"
        },
        "spread": 0,
        "opacity": 10
      }
    },
    "spacing": {
      "l": 22.265,
      "m": 14.844,
      "s": 11.133,
      "xl": 29.686,
      "xs": 7.421,
      "xxl": 44.53,
      "xxs": 3.711,
      "zero": 0
    },
    "animation": {
      "large": {
        "easing": [
          0.22,
          1,
          0.37,
          1.01
        ],
        "duration": 320
      },
      "easing": [
        0.16,
        1,
        0.16,
        1
      ],
      "duration": 180,
      "popupScale": 0.98,
      "pressDistance": 1
    },
    "iconStyle": "outlined",
    "iconFamily": "Hugeicons",
    "iconWeight": 300,
    "neutralTone": "neutral",
    "buttonRadius": "s",
    "colorEmphasis": 8.372395833333334,
    "letterSpacing": {
      "l": -0.01,
      "m": -0.01,
      "s": -0.045,
      "xl": 0.005,
      "xs": -0.045
    },
    "hugeiconsVariant": "stroke-rounded",
    "primaryForeground": {},
    "primaryActionColor": "neutral-10",
    "colorPalettes": [
      {
        "id": "charter-plum",
        "name": "Plum",
        "description": "Deep plum, lavender, sage, and parchment.",
        "colors": {
          "light": [
            "#321b46",
            "#bda6df",
            "#b8cbb5",
            "#e6d4b3"
          ],
          "dark": [
            "#cbb4ef",
            "#77658e",
            "#94b89b",
            "#c2aa80"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-forest",
        "name": "Forest",
        "description": "Evergreen, soft mint, sky blue, and warm sand.",
        "colors": {
          "light": [
            "#174d38",
            "#c7dfc9",
            "#a3c2e4",
            "#e5d8b9"
          ],
          "dark": [
            "#9bddb7",
            "#537b63",
            "#95b6d5",
            "#c0b08d"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-ink",
        "name": "Ink",
        "description": "Inky blue with slate, stone, and pale copper.",
        "colors": {
          "light": [
            "#233c56",
            "#b0c0cc",
            "#cec9b8",
            "#dbb79c"
          ],
          "dark": [
            "#adcbe8",
            "#607d96",
            "#b6b19e",
            "#cfa488"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-clay",
        "name": "Clay",
        "description": "Burnished clay, blush, sage, and linen.",
        "colors": {
          "light": [
            "#754c37",
            "#e0baa9",
            "#b7c3ab",
            "#e6dbbf"
          ],
          "dark": [
            "#e8b69a",
            "#9f7867",
            "#a1b292",
            "#c7b78f"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-violet",
        "name": "Violet",
        "description": "Rich violet, lilac, eucalyptus, and pale gold.",
        "colors": {
          "light": [
            "#655082",
            "#d6c8e8",
            "#b5cabb",
            "#e4d1aa"
          ],
          "dark": [
            "#cbb2ec",
            "#8e75ae",
            "#9bb9a3",
            "#cdb58a"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-iris",
        "name": "Iris",
        "description": "Iris blue, periwinkle, sea glass, and soft apricot.",
        "colors": {
          "light": [
            "#4d5c96",
            "#bdc8ea",
            "#b7d4cc",
            "#e8c7ab"
          ],
          "dark": [
            "#b4c0f0",
            "#778bc3",
            "#95bfb3",
            "#d0aa89"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-sage",
        "name": "Sage",
        "description": "Woodland sage, pale fern, linen, and dusty lavender.",
        "colors": {
          "light": [
            "#496a55",
            "#c2d3b8",
            "#e2d7bd",
            "#c8bbd5"
          ],
          "dark": [
            "#a3c6a6",
            "#779575",
            "#c3b58f",
            "#b0a0c0"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-olive",
        "name": "Olive",
        "description": "Olive, soft chartreuse, mineral blue, and oat.",
        "colors": {
          "light": [
            "#5d632f",
            "#d6d9af",
            "#b4c8ce",
            "#e5d4b9"
          ],
          "dark": [
            "#c1ca85",
            "#8f9861",
            "#96b1b9",
            "#c7b38d"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-ochre",
        "name": "Ochre",
        "description": "Golden ochre, wheat, pale blue, and moss.",
        "colors": {
          "light": [
            "#805f26",
            "#e7d09a",
            "#b8c9df",
            "#b8c5a6"
          ],
          "dark": [
            "#e0bf7e",
            "#b59859",
            "#9db5d1",
            "#a1b38a"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-copper",
        "name": "Copper",
        "description": "Warm copper, peach, muted teal, and flax.",
        "colors": {
          "light": [
            "#98533a",
            "#ebc1a7",
            "#afc8c1",
            "#dfd3aa"
          ],
          "dark": [
            "#efb191",
            "#b48268",
            "#92b4aa",
            "#c5b88b"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-garnet",
        "name": "Garnet",
        "description": "Garnet, rose, pale sage, and silver blue.",
        "colors": {
          "light": [
            "#793b55",
            "#dfb9c9",
            "#bfccb7",
            "#bccbd5"
          ],
          "dark": [
            "#e5abc5",
            "#ab748d",
            "#a4b894",
            "#9cafbf"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-slate",
        "name": "Slate",
        "description": "Blue slate, mist, parchment, and muted lilac.",
        "colors": {
          "light": [
            "#4a6169",
            "#b8ced0",
            "#e4d6b9",
            "#c9bed8"
          ],
          "dark": [
            "#aecdd2",
            "#799ba4",
            "#c7b68e",
            "#b1a2c4"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      },
      {
        "id": "charter-monochrome",
        "name": "Monochrome",
        "description": "Warm charcoal, stone, and soft paper whites.",
        "colors": {
          "light": [
            "#2a2926",
            "#75736e",
            "#bcbab4",
            "#e8e6e0"
          ],
          "dark": [
            "#e8e6e0",
            "#bcbab4",
            "#75736e",
            "#393833"
          ]
        },
        "primaryForeground": {
          "light": "neutral-2",
          "dark": "neutral-2"
        }
      }
    ],
    "paletteBaseNeutrals": {
      "light": {
        "neutral-1": "#ffffff",
        "neutral-2": "#faf9f6",
        "neutral-3": "#f2f0e9",
        "neutral-4": "#e6e3da",
        "neutral-5": "#d2cfc5",
        "neutral-6": "#a5a196",
        "neutral-7": "#777369",
        "neutral-8": "#555249",
        "neutral-9": "#35332e",
        "neutral-10": "#201f1b"
      },
      "dark": {
        "neutral-1": "#191916",
        "neutral-2": "#20201c",
        "neutral-3": "#292923",
        "neutral-4": "#37372f",
        "neutral-5": "#4b4a40",
        "neutral-6": "#77756a",
        "neutral-7": "#aaa79b",
        "neutral-8": "#cbc8bc",
        "neutral-9": "#e6e3d9",
        "neutral-10": "#faf9f4"
      }
    },
    "keyColorPalette": [
      "#321b46",
      "#174d38",
      "#233c56",
      "#754c37",
      "#655082",
      "#4d5c96",
      "#496a55",
      "#5d632f",
      "#805f26",
      "#98533a",
      "#793b55",
      "#4a6169",
      "#2a2926"
    ]
  },
  "componentTokens": {},
  "componentVariants": {}
};
