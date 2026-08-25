# USDA fixture subset

A dozen real FoodData Central rows in the real CSV shape, committed so tests and
local development never depend on a multi-hundred-megabyte download.

This is deliberately the **actual** file format rather than a convenient JSON
seed: it means the CSV parser, the nutrient-id resolution, and the fiber-state
assignment are exercised by the test suite, not just by production data nobody
runs locally.

Chosen to cover the cases that matter:

- `fiber_state = known`   — lentils, oats, apple, chickpeas
- `fiber_state = unknown` — chicken breast and salmon have no 291 row at all,
  which is the case that must not silently become `0`
- household portions      — apple (1 medium), rice (1 cup), roti (1 piece)
- a near-duplicate pair   — two chicken entries that a trigram search has to
  rank against each other

Refresh from <https://fdc.nal.usda.gov/download-datasets.html>.
