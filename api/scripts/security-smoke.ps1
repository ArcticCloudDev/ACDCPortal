param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string]$Token,
    [string]$NonAdminToken
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonRequest {
    param(
        [string]$Uri,
        [string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [object]$Body = $null
    )

    $requestParams = @{
        Uri = $Uri
        Method = $Method
        Headers = $Headers
        SkipHttpErrorCheck = $true
    }

    if ($Body -ne $null) {
        $requestParams['Body'] = $Body
    }

    try {
        $response = Invoke-WebRequest @requestParams
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = $response.Content
            Success = $true
        }
    } catch {
        $ex = $_.Exception
        $status = 0
        if ($ex.Response) {
            $status = [int]($ex.Response.StatusCode)
        }

        $content = ''
        if ($ex.Response -and $ex.Response.Content) {
            try {
                $content = $ex.Response.Content | Out-String
            } catch {
                $content = ''
            }
        }

        return [pscustomobject]@{
            StatusCode = $status
            Body = $content
            Success = $false
        }
    }
}

function Get-AuthHeaders([string]$Jwt) {
    if ([string]::IsNullOrWhiteSpace($Jwt)) {
        return @{}
    }

    return @{ Authorization = "Bearer $Jwt"; 'x-acdc-token' = $Jwt }
}

$tests = @(
    @{ Route = '/users'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 200 } },
    @{ Route = '/users/all'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } },
    @{ Route = '/users/00000000-0000-0000-0000-000000000000'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 404; NonAdmin = 403 } },
    @{ Route = '/teams'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 200 } },
    @{ Route = '/teams/00000000-0000-0000-0000-000000000000'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 404; NonAdmin = 403 } },
    @{ Route = '/participations'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 200 } },
    @{ Route = '/participations/all'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } },
    @{ Route = '/badge-claims'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 200 } },
    @{ Route = '/solo-queue'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 200 } },
    @{ Route = '/invitations/00000000-0000-0000-0000-000000000000'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 404; NonAdmin = 404 } },
    @{ Route = '/email/campaigns'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } },
    @{ Route = '/sequences'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } },
    @{ Route = '/errors'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } },
    @{ Route = '/interest'; Method = 'GET'; Expect = @{ NoToken = 401; Token = 200; NonAdmin = 403 } }
)

$results = @()

foreach ($test in $tests) {
    $noTokenResult = Invoke-JsonRequest -Uri ($BaseUrl.TrimEnd('/') + $test.Route) -Method $test.Method
    $noTokenStatus = [int]$noTokenResult.StatusCode
    $expectedNoToken = $test.Expect.NoToken
    $noTokenPass = $noTokenStatus -eq $expectedNoToken

    $tokenResult = $null
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $tokenResult = Invoke-JsonRequest -Uri ($BaseUrl.TrimEnd('/') + $test.Route) -Method $test.Method -Headers (Get-AuthHeaders $Token)
    } else {
        $tokenResult = [pscustomobject]@{ StatusCode = 0; Body = '' }
    }

    $nonAdminResult = $null
    if (-not [string]::IsNullOrWhiteSpace($NonAdminToken)) {
        $nonAdminResult = Invoke-JsonRequest -Uri ($BaseUrl.TrimEnd('/') + $test.Route) -Method $test.Method -Headers (Get-AuthHeaders $NonAdminToken)
    } else {
        $nonAdminResult = [pscustomobject]@{ StatusCode = 0; Body = '' }
    }

    $tokenStatus = [int]$tokenResult.StatusCode
    $nonAdminStatus = [int]$nonAdminResult.StatusCode

    $tokenPass = if ([string]::IsNullOrWhiteSpace($Token)) { $true } else { $tokenStatus -eq $test.Expect.Token }
    $nonAdminPass = if ([string]::IsNullOrWhiteSpace($NonAdminToken)) { $true } else { $nonAdminStatus -eq $test.Expect.NonAdmin }

    $results += [pscustomobject]@{
        Route = $test.Route
        NoToken = $noTokenStatus
        ExpectedNoToken = $expectedNoToken
        WithToken = $tokenStatus
        ExpectedWithToken = $test.Expect.Token
        NonAdmin = $nonAdminStatus
        ExpectedNonAdmin = $test.Expect.NonAdmin
        Pass = $noTokenPass -and $tokenPass -and $nonAdminPass
    }
}

$failures = $results | Where-Object { -not $_.Pass }
Write-Host 'Security smoke check'
Write-Host '-------------------'
$results | Format-Table -AutoSize Route, NoToken, ExpectedNoToken, WithToken, ExpectedWithToken, NonAdmin, ExpectedNonAdmin, Pass

if ($failures.Count -gt 0) {
    Write-Error "Security smoke check FAILED: $($failures.Count) route(s) did not match the expected policy."
    exit 1
}

Write-Host 'PASS: all sensitive routes matched the expected security policy.'
exit 0
