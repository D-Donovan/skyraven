<?php
declare(strict_types=1);

/**
 * SkyRaven — refresh the same-origin ISS TLE fallback (PHP port of
 * tools/fetch_iss_tle.py). Fetches the current TLE and writes iss-tle.json
 * into THIS script's own directory (__DIR__), so drop this file in the app's
 * data/ folder and it keeps ./data/iss-tle.json fresh.
 *
 * Why server-side: the fetch runs from the HOST, which can reach the API even
 * when a client's network (corporate proxy / endpoint security) blocks it — so
 * the bundled fallback stays current for everyone without re-uploading the zip.
 *
 * Run it either way:
 *   - CLI / cron:   php fetch_iss_tle.php [force]
 *                   e.g. hourly:  7 * * * * php /path/to/SkyRaven/data/fetch_iss_tle.php
 *   - HTTP:         curl https://host/SkyRaven/data/fetch_iss_tle.php[?force=1]
 *
 * By default it SKIPS the network call if iss-tle.json is younger than MIN_AGE,
 * so it's cheap to call often; pass force to override. Tested against PHP 8.4.
 */

const TLE_URL  = 'https://api.wheretheiss.at/v1/satellites/25544/tles';
const OUT_NAME = 'iss-tle.json';
const TIMEOUT  = 15;         // seconds for the upstream request
const MIN_AGE  = 3 * 3600;   // don't refetch if the file is newer than this

$cli     = PHP_SAPI === 'cli';
$outPath = __DIR__ . DIRECTORY_SEPARATOR . OUT_NAME;

/** Print a status line with the right exit code / HTTP status, then stop. */
function done(string $msg, int $code): never
{
    global $cli;
    if (!$cli) {
        header('Content-Type: text/plain; charset=utf-8');
        if ($code !== 0) {
            http_response_code(500);
        }
    }
    echo $msg, "\n";
    exit($code);
}

// Forced refresh: "force" arg on the CLI, or ?force= in the query string.
$force = ($cli && in_array('force', array_slice($argv, 1), true))
      || (!$cli && isset($_GET['force']));

if (!$force && is_file($outPath) && (time() - filemtime($outPath)) < MIN_AGE) {
    $age = time() - filemtime($outPath);
    done('skip: ' . OUT_NAME . " is fresh ({$age}s old, < " . MIN_AGE . 's) — pass force to override', 0);
}

// --- fetch (cURL preferred; fall back to file_get_contents) ----------------
$raw = null;
if (function_exists('curl_init')) {
    $ch = curl_init(TLE_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => TIMEOUT,
        CURLOPT_TIMEOUT        => TIMEOUT,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT      => 'SkyRaven-TLE-refresh/1.0',
    ]);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        done("error: fetch failed: {$err}", 1);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($status !== 200) {
        done("error: upstream HTTP {$status}", 1);
    }
} else {
    $ctx = stream_context_create(['http' => [
        'timeout' => TIMEOUT,
        'header'  => "User-Agent: SkyRaven-TLE-refresh/1.0\r\n",
    ]]);
    $raw = @file_get_contents(TLE_URL, false, $ctx);
    if ($raw === false) {
        done('error: fetch failed (no cURL; check allow_url_fopen)', 1);
    }
}

// --- parse + validate ------------------------------------------------------
try {
    $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    done('error: upstream returned invalid JSON: ' . $e->getMessage(), 1);
}

$line1 = $data['line1'] ?? null;
$line2 = $data['line2'] ?? null;
if (!is_string($line1) || !is_string($line2) || $line1 === '' || $line2 === '') {
    done('error: response missing line1/line2', 1);
}

$bundle = [
    'line1'         => $line1,
    'line2'         => $line2,
    'tle_timestamp' => $data['tle_timestamp'] ?? null,
];

// --- write atomically (temp file + rename) ---------------------------------
$json = json_encode($bundle, JSON_UNESCAPED_SLASHES) . "\n";
$tmp  = $outPath . '.tmp';
if (file_put_contents($tmp, $json, LOCK_EX) === false || !rename($tmp, $outPath)) {
    @unlink($tmp);
    done('error: could not write ' . OUT_NAME . ' (check directory permissions)', 1);
}

done('wrote ' . OUT_NAME . ' (tle_timestamp=' . ($bundle['tle_timestamp'] ?? 'null') . ')', 0);
