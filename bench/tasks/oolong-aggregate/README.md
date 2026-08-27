# OOLONG-lite tasks

Seeded JSONL aggregation pair used by the WP3.3 kernel-arbiter pilot. Three task directories share one generator and one seed:

- `oolong-aggregate` — four exact-integer questions over the corpus.
- `oolong-pairs` — a 3×3 (range-bucket × category) count matrix over the same corpus.
- `oolong-aggregate-cued` — byte-identical corpus and questions to `oolong-aggregate`, with an arm-adaptive capability cue as the instruction's final line.

## Regeneration

```sh
node bench/tasks/oolong-aggregate/generate.mjs
```

`task.json` `seed` (20260826) is the only randomness input (`mulberry32`). The same seed rewrites identical ids, names, values, categories, question constants, stuffed instruction text, and `expectedAnswers`. The three `fixture/corpus.jsonl` files are byte-identical. Trials do not regenerate: the committed fixtures are what the runner copies.

Names are 3–6 character consonant-vowel tokens from a fixed non-English table so they are not recallable words. Ids are `r` plus a zero-padded index (`r000`–`r399`).
