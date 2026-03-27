using System.Text.Json;

namespace WeatherApi.Middleware;

public class KratosAuthMiddleware(RequestDelegate next, IConfiguration config, ILogger<KratosAuthMiddleware> logger)
{
    private static readonly string[] WriteMethods = [HttpMethods.Post, HttpMethods.Put, HttpMethods.Delete, HttpMethods.Patch];
    private static readonly HashSet<string> AllowedRoles = ["admin", "weather_admin"];

    private readonly string _kratosPublicUrl = config.GetValue<string>("OryKratosPublicUrl") ?? "http://localhost:4433";

    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/signup"))
        {
            await next(context);
            return;
        }

        if (!WriteMethods.Contains(context.Request.Method, StringComparer.OrdinalIgnoreCase))
        {
            await next(context);
            return;
        }

        var cookieHeader = string.Join("; ", context.Request.Cookies.Select(c => $"{c.Key}={c.Value}"));
        if (string.IsNullOrEmpty(cookieHeader))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsync("Unauthorized: no session cookie");
            return;
        }

        using var httpClient = new HttpClient();
        httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Cookie", cookieHeader);
        httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");

        HttpResponseMessage response;
        try
        {
            response = await httpClient.GetAsync($"{_kratosPublicUrl}/sessions/whoami");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to reach Kratos at {Url}", _kratosPublicUrl);
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await context.Response.WriteAsync("Auth service unavailable");
            return;
        }

        if (!response.IsSuccessStatusCode)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsync("Unauthorized: invalid or expired session");
            return;
        }

        var body = await response.Content.ReadAsStringAsync();
        string? role = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("identity", out var identity) &&
                identity.TryGetProperty("traits", out var traits) &&
                traits.TryGetProperty("role", out var roleElement))
            {
                role = roleElement.GetString();
            }
        }
        catch (JsonException ex)
        {
            logger.LogError(ex, "Failed to parse Kratos session response");
            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
            await context.Response.WriteAsync("Auth error");
            return;
        }

        if (role == null || !AllowedRoles.Contains(role))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsync("Forbidden: insufficient role");
            return;
        }

        await next(context);
    }
}
