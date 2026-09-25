# Live end-to-end verification against a running local Worker (ASCII only, to
# avoid PowerShell 5.1 encoding problems with Vietnamese text).
#
# Run after: npx wrangler dev --local --port 8787

$ErrorActionPreference = "Continue"
$BASE = "http://127.0.0.1:8787"
$script:pass = 0; $script:fail = 0; $script:failures = @()

function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host "  OK   $name" }
  else { $script:fail++; $script:failures += "$name -> $detail"; Write-Host "  FAIL $name  -> $detail" }
}

function Status($method, $path, $headers, $body, $session) {
  # Dung HttpWebRequest voi AllowAutoRedirect = false: neu de PowerShell tu
  # di theo redirect thi "302 -> /login" se bi bao nham thanh 200.
  $req = [System.Net.HttpWebRequest]::Create("$BASE$path")
  $req.Method = $method
  $req.AllowAutoRedirect = $false
  $req.Timeout = 15000
  if ($headers) { foreach ($k in $headers.Keys) { $req.Headers.Add($k, $headers[$k]) } }
  if ($session) { $req.Headers.Add("Cookie", $session) }
  if ($body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $req.ContentType = "application/json"
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  }
  try {
    $r = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
    $text = $sr.ReadToEnd()
    $code = [int]$r.StatusCode
    $loc = $r.Headers["Location"]
    $sc = $r.Headers["Set-Cookie"]
    $ct = $r.Headers["Content-Type"]
    $r.Close()
    return @{ code = $code; body = $text; location = $loc; setcookie = $sc; ctype = $ct }
  } catch {
    $resp = $_.Exception.Response
    if ($resp -eq $null) { return @{ code = 0; body = $_.Exception.Message; location = ""; setcookie = ""; ctype = "" } }
    $code = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $sr.ReadToEnd()
    return @{ code = $code; body = $text; location = $resp.Headers["Location"]; setcookie = $resp.Headers["Set-Cookie"]; ctype = $resp.Headers["Content-Type"] }
  }
}

Write-Host ""
Write-Host "=== A. Sync API must reject missing / wrong token ==="
$r = Status "POST" "/api/sync" $null '{"synced_at":"2026-09-22T17:30:00+07:00"}'
Check "POST /api/sync no token -> 401" ($r.code -eq 401) "got $($r.code)"

$r = Status "POST" "/api/sync" @{ Authorization = "Bearer wrong-token-here" } '{"synced_at":"2026-09-22T17:30:00+07:00"}'
Check "POST /api/sync wrong token -> 401" ($r.code -eq 401) "got $($r.code)"

$r = Status "GET" "/api/sync" $null $null
Check "GET /api/sync -> 405" ($r.code -eq 405) "got $($r.code)"

Write-Host ""
Write-Host "=== B. Protected endpoints must be 401 when not logged in ==="
foreach ($p in @("/api/stats", "/api/stats/daily", "/api/stats/products", "/api/logs", "/api/logs/syncs", "/api/images")) {
  $r = Status "GET" $p $null $null
  Check "GET $p -> 401" ($r.code -eq 401) "got $($r.code)"
}
$r = Status "GET" "/api/images/img_11111111-2222-3333-4444-555555555555.jpg" $null $null
Check "GET image (not logged in) -> 401" ($r.code -eq 401) "got $($r.code)"

Write-Host ""
Write-Host "=== C. Dashboard pages redirect when not logged in ==="
$r = Status "GET" "/index.html" $null $null
Check "/index.html not logged in -> 302" ($r.code -eq 302) "got $($r.code)"
$r = Status "GET" "/login.html" $null $null
Check "/login.html reachable -> 200" ($r.code -eq 200) "got $($r.code)"
$r = Status "GET" "/api/health" $null $null
Check "/api/health public -> 200" ($r.code -eq 200) "got $($r.code)"

Write-Host ""
Write-Host "=== D. Login rate limit: 5 failures / 15 min / IP ==="
$r = Status "POST" "/api/login" $null '{"password":"definitely-wrong"}'
Check "wrong password -> 401" ($r.code -eq 401) "got $($r.code)"
Check "401 body has invalid_credentials code" ($r.body -match 'invalid_credentials') $r.body

$got429 = $false
for ($i = 2; $i -le 8; $i++) {
  $r = Status "POST" "/api/login" $null '{"password":"definitely-wrong"}'
  if ($r.code -eq 429) { $got429 = $true; Write-Host "      429 after $i attempts"; break }
}
Check "rate limit kicks in at 5 wrong logins -> 429" $got429 "never returned 429"

# The rate limit must also block a CORRECT password from the same IP: that is
# the whole point of a brute-force lock.
$r = Status "POST" "/api/login" $null ("{""password"":""" + $env:ADMIN_PASSWORD + """}")
Check "correct password while rate-limited -> 429 (lock holds)" ($r.code -eq 429) "got $($r.code)"

Write-Host ""
Write-Host "=== E. Unlock via authenticated session, then real login ==="
Write-Host "      (requires an existing session cookie; see unlock-note below)"
if ($env:TEST_SESSION) {
  $r = Status "POST" "/api/admin/unlock-login" $null '{"ips":[]}' $env:TEST_SESSION
  Check "POST /api/admin/unlock-login with session -> 200" ($r.code -eq 200) "got $($r.code)"

  $r = Status "POST" "/api/login" $null ("{""password"":""" + $env:ADMIN_PASSWORD + """}")
  Check "correct password -> 200 after unlock" ($r.code -eq 200) "got $($r.code)"
  Check "Set-Cookie is HttpOnly" ($r.setcookie -match 'HttpOnly') $r.setcookie
  Check "Set-Cookie is Secure" ($r.setcookie -match 'Secure') $r.setcookie
  Check "Set-Cookie is SameSite=Strict" ($r.setcookie -match 'SameSite=Strict') $r.setcookie
  Check "Set-Cookie is Path=/" ($r.setcookie -match 'Path=/') $r.setcookie

  $cookie = ($r.setcookie -split ';')[0]
  $r = Status "GET" "/api/stats" $null $null $cookie
  Check "GET /api/stats WITH session -> 200" ($r.code -eq 200) "got $($r.code)"
  Check "stats response is JSON" ($r.ctype -match 'application/json') $r.ctype
  Check "stats has totals + by_day" ($r.body -match '"totals"' -and $r.body -match '"by_day"') $r.body.Substring(0, [Math]::Min(120, $r.body.Length))

  $r = Status "GET" "/" $null $null $cookie
  Check "GET / WITH session -> 200 (dashboard served)" ($r.code -eq 200) "got $($r.code)"
  $r = Status "GET" "/index.html" $null $null $cookie
  Check "GET /index.html WITH session -> 200" ($r.code -eq 200) "got $($r.code)"
} else {
  Write-Host "      TEST_SESSION not set - section E skipped."
}

Write-Host ""
Write-Host "=== SUMMARY ==="
Write-Host "  $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { $script:failures | ForEach-Object { Write-Host "   - $_" } }
exit $script:fail
