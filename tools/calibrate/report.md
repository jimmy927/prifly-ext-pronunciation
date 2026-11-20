# Calibration report

Generated 2026-11-20 00:58 by tools/calibrate/stats.py from /workspace/calibrate/dump.

## Data

| corpus | kind | utterances | failed | words | judged words |
|---|---|---|---|---|---|
| librispeech | native | 2990 | 0 | 60548 | 29804 |
| speechocean762 | learner | 5000 | 0 | 31812 | 16522 |
| vctk | native | 3548 | 0 | 35755 | 18698 |

## Checks

Native false-alarm budget: 0.0050 per judged word for maybe, 0.0010 for sure; ship bar: precision ≥ 0.80 on at least 20 labelled learner flags. A learner flag is right when the raters scored that phone under 1.5 (speechocean762, 0 to 2 per phone) or annotated it as an error (L2-ARCTIC); strict also needs the perceived phone to be the one flagged (speechocean762 names it only for phones scored under 0.5, so strict sits well under precision there). The flagged phone is looked up by lining up our pronunciation with the raters' phones. Recall counts the labelled swaps of that kind found.

| check | native flags/word at 0.70 | maybe | native rate at maybe | sure | learner flags | labelled | precision | strict | recall | ships |
|---|---|---|---|---|---|---|---|---|---|---|
| z-s | 0.0007 | 0.500 | 0.0007 | 0.500 | 24 | 22 | 0.545 | 0.091 | 0.400 | off: precision 0.55 under 0.80 |
| final-devoicing | 0.0011 | 0.500 | 0.0015 | 0.725 | 423 | 411 | 0.165 | 0.019 | 0.500 | off: precision 0.17 under 0.80 |
| th | 0.0006 | 0.500 | 0.0009 | 0.500 | 372 | 372 | 0.145 | 0.022 | 0.364 | off: precision 0.15 under 0.80 |
| w-v | 0.0000 | 0.500 | 0.0000 | 0.500 | 115 | 115 | 0.087 | 0.017 | 1.000 | off: precision 0.09 under 0.80 |
| sh-ch | 0.0004 | 0.500 | 0.0007 | 0.500 | 16 | 16 | 0.125 | 0.000 | 0.000 | off: only 16 labelled learner flags (need 20) |

Per learner corpus, at each check's maybe cut-off:

| check | corpus | flags | labelled | precision | strict | recall |
|---|---|---|---|---|---|---|
| z-s | l2arctic | 0 | 0 | – | – | – |
| z-s | speechocean762 | 24 | 22 | 0.545 | 0.091 | 0.400 |
| final-devoicing | l2arctic | 0 | 0 | – | – | – |
| final-devoicing | speechocean762 | 423 | 411 | 0.165 | 0.019 | 0.500 |
| th | l2arctic | 0 | 0 | – | – | – |
| th | speechocean762 | 372 | 372 | 0.145 | 0.022 | 0.364 |
| w-v | l2arctic | 0 | 0 | – | – | – |
| w-v | speechocean762 | 115 | 115 | 0.087 | 0.017 | 1.000 |
| sh-ch | l2arctic | 0 | 0 | – | – | – |
| sh-ch | speechocean762 | 16 | 16 | 0.125 | 0.000 | 0.000 |

Native flags per judged word by cut-off:

| check | 0.5 | 0.6 | 0.7 | 0.8 | 0.88 | 0.9 | 0.95 | 0.99 |
|---|---|---|---|---|---|---|---|---|
| z-s | 0.0007 | 0.0007 | 0.0007 | 0.0006 | 0.0005 | 0.0005 | 0.0004 | 0.0000 |
| final-devoicing | 0.0015 | 0.0013 | 0.0011 | 0.0008 | 0.0006 | 0.0005 | 0.0002 | 0.0000 |
| th | 0.0009 | 0.0007 | 0.0006 | 0.0005 | 0.0004 | 0.0003 | 0.0002 | 0.0000 |
| w-v | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| sh-ch | 0.0007 | 0.0006 | 0.0004 | 0.0002 | 0.0001 | 0.0001 | 0.0000 | 0.0000 |

## Native phones (LPR: log posterior of the phone minus its best competitor)

| phone | n | p1 | p5 | p10 | p50 | p90 |
|---|---|---|---|---|---|---|
| aɪ | 5819 | -1.165 | 2.078 | 2.658 | 3.784 | 4.496 |
| aʊ | 1923 | -3.719 | 1.228 | 1.628 | 2.554 | 3.255 |
| b | 7085 | 0.742 | 2.720 | 3.403 | 4.888 | 5.668 |
| d | 15857 | -2.639 | 0.787 | 2.365 | 4.984 | 6.335 |
| dʒ | 1352 | 1.238 | 2.592 | 3.013 | 4.091 | 4.708 |
| eɪ | 5580 | -0.645 | 2.833 | 3.478 | 4.674 | 5.339 |
| f | 6462 | -0.169 | 2.926 | 3.522 | 4.917 | 5.790 |
| h | 6433 | -3.033 | 3.391 | 4.672 | 6.370 | 7.163 |
| i | 3756 | 1.256 | 2.658 | 3.250 | 5.794 | 6.661 |
| iː | 7925 | -2.281 | 0.904 | 1.853 | 3.887 | 5.050 |
| j | 1956 | -1.630 | 2.436 | 3.421 | 4.874 | 5.673 |
| k | 9328 | 1.031 | 3.498 | 4.096 | 5.377 | 6.108 |
| l | 12985 | 1.902 | 4.228 | 4.909 | 6.004 | 6.831 |
| m | 9021 | 1.320 | 3.379 | 4.095 | 6.350 | 7.538 |
| n | 23932 | -0.733 | 2.826 | 4.256 | 6.329 | 7.273 |
| oʊ | 710 | -5.723 | -1.613 | 0.802 | 2.820 | 3.511 |
| p | 6622 | 1.132 | 3.126 | 3.653 | 4.946 | 5.875 |
| s | 15747 | -1.265 | 2.318 | 3.399 | 5.069 | 6.056 |
| t | 22521 | -0.911 | 1.952 | 2.726 | 4.336 | 5.967 |
| tʃ | 1747 | -2.066 | 0.789 | 1.486 | 2.714 | 3.388 |
| uː | 3534 | -5.088 | 0.128 | 1.325 | 3.847 | 4.783 |
| v | 7144 | -0.228 | 3.687 | 4.474 | 5.887 | 6.650 |
| w | 7640 | 0.369 | 3.856 | 4.631 | 6.051 | 6.873 |
| z | 10977 | -2.013 | 1.540 | 2.490 | 3.931 | 4.805 |
| æ | 9898 | -1.199 | 0.752 | 1.238 | 3.399 | 4.513 |
| ð | 12293 | -0.765 | 2.123 | 3.188 | 5.327 | 6.245 |
| ŋ | 3187 | -2.523 | 1.675 | 2.333 | 4.065 | 4.755 |
| ɐ | 3682 | -1.574 | 1.170 | 1.923 | 3.434 | 4.434 |
| ɑː | 2084 | -4.059 | 0.182 | 0.805 | 2.209 | 2.742 |
| ɒ | 3345 | -1.610 | 0.358 | 0.863 | 1.982 | 2.677 |
| ɔɪ | 364 | -2.408 | -1.643 | -1.406 | -0.824 | -0.437 |
| ɔː | 4374 | -1.993 | -0.575 | 0.042 | 1.596 | 2.571 |
| ə | 29951 | -1.953 | 0.539 | 1.528 | 4.412 | 5.729 |
| əʊ | 4064 | -1.621 | 1.167 | 1.736 | 2.952 | 3.660 |
| ɚ | 5407 | -1.164 | 1.162 | 1.886 | 4.152 | 4.949 |
| ɛ | 8449 | -3.499 | 0.607 | 1.613 | 3.426 | 4.610 |
| ɛə | 947 | -3.131 | -2.295 | -0.616 | 0.751 | 1.840 |
| ɜː | 1919 | -1.973 | 1.331 | 1.640 | 2.385 | 3.022 |
| ɡ | 2935 | -0.996 | 2.388 | 3.002 | 4.280 | 5.054 |
| ɪ | 22824 | -4.120 | 0.490 | 1.938 | 4.412 | 5.404 |
| ɪə | 461 | -3.672 | -1.517 | -0.887 | 0.736 | 1.583 |
| ɹ | 11818 | -0.978 | 2.025 | 3.840 | 5.872 | 6.571 |
| ʃ | 2507 | -1.197 | 1.911 | 2.750 | 4.238 | 5.060 |
| ʊ | 1587 | -5.323 | -2.752 | -1.879 | 0.545 | 2.289 |
| ʊə | 199 | -3.650 | -3.346 | -2.964 | 0.504 | 1.921 |
| ʌ | 1926 | 0.195 | 2.071 | 2.551 | 3.641 | 4.502 |
| ʒ | 211 | -5.880 | -0.004 | 0.523 | 1.634 | 2.619 |
| θ | 1744 | -5.944 | -1.114 | 0.733 | 3.416 | 4.356 |

## Native vowels

| vowel | n | LPR p5 | LPR p50 | ms p10 | ms p50 | ms p90 |
|---|---|---|---|---|---|---|
| aɪ | 5819 | 2.078 | 3.784 | 70.000 | 110.000 | 170.000 |
| aʊ | 1923 | 1.228 | 2.554 | 70.000 | 100.000 | 150.000 |
| eɪ | 5580 | 2.833 | 4.674 | 70.000 | 90.000 | 140.000 |
| i | 3756 | 2.658 | 5.794 | 50.000 | 80.000 | 130.000 |
| iː | 7925 | 0.904 | 3.887 | 60.000 | 80.000 | 130.000 |
| oʊ | 710 | -1.613 | 2.820 | 70.000 | 100.000 | 160.000 |
| uː | 3534 | 0.128 | 3.847 | 50.000 | 80.000 | 130.000 |
| æ | 9898 | 0.752 | 3.399 | 50.000 | 90.000 | 150.000 |
| ɐ | 3682 | 1.170 | 3.434 | 50.000 | 70.000 | 110.000 |
| ɑː | 2084 | 0.182 | 2.209 | 70.000 | 100.000 | 160.000 |
| ɒ | 3345 | 0.358 | 1.982 | 60.000 | 90.000 | 140.000 |
| ɔɪ | 364 | -1.643 | -0.824 | 90.000 | 120.000 | 160.000 |
| ɔː | 4374 | -0.575 | 1.596 | 60.000 | 100.000 | 160.000 |
| ə | 29951 | 0.539 | 4.412 | 40.000 | 60.000 | 90.000 |
| əʊ | 4064 | 1.167 | 2.952 | 70.000 | 100.000 | 140.000 |
| ɚ | 5407 | 1.162 | 4.152 | 50.000 | 80.000 | 130.000 |
| ɛ | 8449 | 0.607 | 3.426 | 50.000 | 80.000 | 120.000 |
| ɛə | 947 | -2.295 | 0.751 | 60.000 | 90.000 | 160.000 |
| ɜː | 1919 | 1.331 | 2.385 | 70.000 | 100.000 | 160.000 |
| ɪ | 22824 | 0.490 | 4.412 | 40.000 | 60.000 | 110.000 |
| ɪə | 461 | -1.517 | 0.736 | 80.000 | 120.000 | 160.000 |
| ʊ | 1587 | -2.752 | 0.545 | 40.000 | 60.000 | 100.000 |
| ʊə | 199 | -3.346 | 0.504 | 50.000 | 80.000 | 150.000 |
| ʌ | 1926 | 2.071 | 3.641 | 40.000 | 60.000 | 110.000 |

## Native stress margins

Stressed vowel minus the strongest other vowel of the same word (words of 2+ vowels with a dictionary stress): length as a log ratio, loudness in dB, pitch in semitones.

| cue | n | p5 | p10 | p25 | p50 | p75 | stressed one wins |
|---|---|---|---|---|---|---|---|
| durationLogRatio | 25606 | -0.619 | -0.452 | -0.167 | 0.134 | 0.435 | 0.553 |
| rmsDb | 25606 | -3.492 | -1.948 | 0.314 | 2.721 | 5.505 | 0.778 |
| f0Semitones | 15924 | -4.254 | -2.787 | -0.874 | 0.541 | 2.359 | 0.607 |

## Word stress

How it is judged (pronounce/stress.ts, mirrored by `stress_readings` here): a word is read when it is no function word, Britfone has it, and its chosen pronunciation has 2+ vowels and a stress. Each vowel's length (log ms), loudness (dB) and pitch (semitones) is scaled by the mean and spread of all the sentence's vowels, so the speaker's rate, level and voice cancel out; a vowel's prominence is the mean of its scaled cues (pitch only when every vowel of the word is voiced: `dur+rms+f0`, else `dur+rms`). The word's lead is the most prominent other vowel's prominence minus the stressed one's; a lead to a syllable another accepted pronunciation stresses is never a flag.

Natives set the cut-offs per combination: the lowest lead at which at most 0.0050 of their read words would be marked (`maybe`), 0.0010 (`sure`), on at least 2000 native words. It ships only when learners' flags are right at least 80% of the time on at least 20 flags the raters scored: a flag is right when speechocean762 scored the word's stress under 7.5 (5: wrong; 10: right). L2-ARCTIC has no stress labels. Without learner stress scores the check stays off: a native false-alarm cap alone says how rarely natives are flagged, not how often a learner's flag is right.

| combination | native words read | native rate at lead 0.05 | maybe | native rate at maybe | sure |
|---|---|---|---|---|---|
| dur+rms+f0 | 11229 | 0.1840 | 1.150 | 0.0046 | 1.600 |
| dur+rms | 10406 | 0.1558 | 1.250 | 0.0050 | 1.800 |

| learners | words read | scored | scored wrong | flags | scored flags | precision | recall |
|---|---|---|---|---|---|---|---|
| l2arctic | 0 | 0 | 0 | 0 | 0 | – | – |
| speechocean762 | 4772 | 4772 | 171 | 160 | 160 | 0.194 | 0.181 |

Ships: off: precision 0.19 under 0.80 (all learners: 160 scored flags, precision 0.194).
