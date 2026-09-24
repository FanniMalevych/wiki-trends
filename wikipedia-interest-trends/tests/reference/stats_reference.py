"""Independent reference values for the TypeScript statistics (development only).

Plain Python, no packages: a direct transcription of
  - scipy.stats.theilslopes (slope, intercept, Sen 1968 confidence interval)
  - pymannkendall.original_test and hamed_rao_modification_test
written from their published source rather than from our TypeScript. Uses the
exact math.erfc, so it also checks our erfc approximation.

Regenerate:  python3 tests/reference/stats_reference.py > tests/fixtures/stats-reference.json
If scipy and pymannkendall are installed, --check compares against the real libraries
(last run: scipy 1.18.1, pymannkendall 1.4.3, 2026-09-24 - all match).
"""
import json
import math
import random
import sys

Z_975 = 1.959963984540054  # scipy.stats.norm.ppf(0.975)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def repeats(xs):
    counts = {}
    for x in xs:
        counts[x] = counts.get(x, 0) + 1
    return [c for c in counts.values() if c > 1]


def theilslopes(y):
    n = len(y)
    x = list(range(n))
    slopes = sorted((y[j] - y[i]) / (x[j] - x[i]) for i in range(n) for j in range(n) if x[j] > x[i])
    slope = median(slopes)
    intercept = median(y) - slope * median(x)
    z = -Z_975  # norm.ppf(alpha / 2)
    nt, ny = len(slopes), n
    sigsq = 1 / 18.0 * (ny * (ny - 1) * (2 * ny + 5) - sum(k * (k - 1) * (2 * k + 5) for k in repeats(y)))
    sigma = math.sqrt(sigsq)
    ru = min(int(round((nt - z * sigma) / 2.0)), nt - 1)  # Python round == numpy round (half to even)
    rl = max(int(round((nt + z * sigma) / 2.0)) - 1, 0)
    return {"slope": slope, "intercept": intercept, "low": slopes[rl], "high": slopes[ru]}


def rankdata(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def mk_score(x):
    n = len(x)
    return sum((x[j] > x[i]) - (x[j] < x[i]) for i in range(n) for j in range(i + 1, n))


def variance_s(x):
    n = len(x)
    return (n * (n - 1) * (2 * n + 5) - sum(t * (t - 1) * (2 * t + 5) for t in repeats(x))) / 18


def z_score(s, var_s):
    if s > 0:
        return (s - 1) / math.sqrt(var_s)
    if s < 0:
        return (s + 1) / math.sqrt(var_s)
    return 0.0


def acf(x, nlags):
    n = len(x)
    m = sum(x) / n
    y = [v - m for v in x]
    acov = [sum(y[t] * y[t + k] for t in range(n - k)) / n for k in range(nlags + 1)]
    return [a / acov[0] for a in acov]


def sens_slope(x):
    n = len(x)
    return median([(x[j] - x[i]) / (j - i) for i in range(n) for j in range(i + 1, n)])


def mann_kendall(x, hamed_rao):
    n = len(x)
    s = mk_score(x)
    var_s = variance_s(x)
    if hamed_rao:
        slope = sens_slope(x)
        ranks = rankdata([x[i] - (i + 1) * slope for i in range(n)])
        if len(set(ranks)) == 1:
            # Deliberate deviation: a perfectly linear series has constant detrended
            # ranks (autocorrelation 0/0). pymannkendall returns NaN; we skip the correction.
            z = z_score(s, var_s)
            return {"s": s, "varS": var_s, "z": z, "p": math.erfc(abs(z) / math.sqrt(2)), "tau": s / (0.5 * n * (n - 1))}
        rho = acf(ranks, n - 1)
        bound = Z_975 / math.sqrt(n)
        sni = sum((n - i) * (n - i - 1) * (n - i - 2) * rho[i] for i in range(1, n) if not (-bound <= rho[i] <= bound))
        var_s *= 1 + (2 / (n * (n - 1) * (n - 2))) * sni
    z = z_score(s, var_s)
    return {"s": s, "varS": var_s, "z": z, "p": math.erfc(abs(z) / math.sqrt(2)), "tau": s / (0.5 * n * (n - 1))}


def series():
    rng = random.Random(20260924)
    walk, level = [], 0.0
    for _ in range(60):
        level += rng.gauss(0, 1)
        walk.append(round(level, 6))
    trend_noise = [round(0.05 * i + rng.gauss(0, 0.3), 6) for i in range(48)]
    seasonal = [round(0.01 * i + 0.4 * math.sin(2 * math.pi * i / 12) + rng.gauss(0, 0.1), 6) for i in range(60)]
    return {
        "increasing": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        "ties": [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9],
        "flat_with_outlier": [10, 10.2, 9.9, 10.1, 10, 50, 10.1, 9.8, 10, 10.2, 9.9, 10],
        "random_walk": walk,
        "trend_noise": trend_noise,
        "seasonal_trend": seasonal,
        # cs.wikipedia "Přerušovaný_půst", monthly views 2023-09..2025-08 (recorded fixture)
        "cs_intermittent_fasting": [481, 305, 329, 296, 773, 593, 770, 537, 749, 491, 526, 447, 393, 634, 329, 294,
                                    489, 272, 366, 958, 225, 238, 157, 386],
    }


def main():
    cases = []
    for name, y in series().items():
        cases.append({
            "name": name,
            "y": y,
            "theilSen": theilslopes(y),
            "mannKendall": mann_kendall(y, hamed_rao=False),
            "mannKendallHamedRao": mann_kendall(y, hamed_rao=True),
        })
    if "--check" in sys.argv:
        # Compare with the real libraries. pymannkendall computes p as 2*(1 - cdf(z)),
        # which loses precision below ~1e-10 (it returns 0 for p ~ 2e-20), so p-values
        # are checked against SciPy's exact normal tail instead; S, Var(S) and z against
        # pymannkendall itself.
        import pymannkendall as pmk
        from scipy import stats
        for c in cases:
            ref = stats.theilslopes(c["y"])
            for ours, theirs in [("slope", ref.slope), ("intercept", ref.intercept), ("low", ref.low_slope), ("high", ref.high_slope)]:
                assert math.isclose(theirs, c["theilSen"][ours], rel_tol=1e-12, abs_tol=1e-15), (c["name"], ours)
            for key, test in [("mannKendall", pmk.original_test), ("mannKendallHamedRao", pmk.hamed_rao_modification_test)]:
                if key == "mannKendallHamedRao" and c["name"] == "increasing":
                    continue  # see the deliberate deviation in mann_kendall
                r, o = test(c["y"]), c[key]
                assert r.s == o["s"], (c["name"], key, "s")
                assert math.isclose(r.var_s, o["varS"], rel_tol=1e-9), (c["name"], key, "varS")
                assert math.isclose(r.z, o["z"], rel_tol=1e-9), (c["name"], key, "z")
                assert math.isclose(2 * stats.norm.sf(abs(o["z"])), o["p"], rel_tol=1e-9), (c["name"], key, "p")
        print("reference matches scipy (Theil-Sen, exact p-values) and pymannkendall (S, Var(S), z)", file=sys.stderr)
    json.dump({"generatedBy": "tests/reference/stats_reference.py", "cases": cases}, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
