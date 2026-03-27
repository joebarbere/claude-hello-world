using Microsoft.EntityFrameworkCore;
using Prometheus;
using Scalar.AspNetCore;
using WeatherApi.Data;
using WeatherApi.Middleware;
using System.Net.Http.Json;
using WeatherApi.Models;
using WeatherApi.Repositories;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

var repositoryType = builder.Configuration.GetValue<string>("Repository") ?? "Random";

switch (repositoryType)
{
    case "EfCore":
        var connectionString = builder.Configuration.GetConnectionString("DefaultConnection");
        builder.Services.AddDbContext<WeatherDbContext>(options => options.UseNpgsql(connectionString));
        builder.Services.AddScoped<IWeatherForecastRepository, EfWeatherForecastRepository>();
        break;
    case "InMemory":
        builder.Services.AddSingleton<IWeatherForecastRepository, InMemoryWeatherForecastRepository>();
        break;
    default: // "Random"
        builder.Services.AddSingleton<IWeatherForecastRepository, RandomWeatherForecastRepository>();
        break;
}

var app = builder.Build();

app.MapOpenApi();
app.MapScalarApiReference();

if (repositoryType == "EfCore")
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<WeatherDbContext>();
    db.Database.Migrate();
}

app.UseHttpsRedirection();
app.UseHttpMetrics();
app.UseMiddleware<KratosAuthMiddleware>();

var forecasts = app.MapGroup("/weatherforecast");

forecasts.MapGet("/", async (IWeatherForecastRepository repo) =>
    Results.Ok(await repo.GetAllAsync()))
    .WithName("GetWeatherForecasts");

forecasts.MapGet("/{id:int}", async (int id, IWeatherForecastRepository repo) =>
{
    var result = await repo.GetByIdAsync(id);
    return result is null ? Results.NotFound() : Results.Ok(result);
})
.WithName("GetWeatherForecastById");

forecasts.MapPost("/", async (WeatherForecast input, IWeatherForecastRepository repo) =>
{
    try
    {
        var created = await repo.CreateAsync(input);
        return Results.Created($"/weatherforecast/{created.Id}", created);
    }
    catch (NotSupportedException ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status405MethodNotAllowed);
    }
})
.WithName("CreateWeatherForecast");

forecasts.MapPut("/{id:int}", async (int id, WeatherForecast input, IWeatherForecastRepository repo) =>
{
    try
    {
        var updated = await repo.UpdateAsync(id, input);
        return updated is null ? Results.NotFound() : Results.Ok(updated);
    }
    catch (NotSupportedException ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status405MethodNotAllowed);
    }
})
.WithName("UpdateWeatherForecast");

forecasts.MapDelete("/{id:int}", async (int id, IWeatherForecastRepository repo) =>
{
    try
    {
        var deleted = await repo.DeleteAsync(id);
        return deleted ? Results.NoContent() : Results.NotFound();
    }
    catch (NotSupportedException ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status405MethodNotAllowed);
    }
})
.WithName("DeleteWeatherForecast");

app.MapPost("/signup", async (SignupRequest request, IConfiguration config) =>
{
    if (string.IsNullOrWhiteSpace(request.Email))
        return Results.BadRequest(new { error = "Email is required" });

    var kratosAdminUrl = config.GetValue<string>("OryKratosAdminUrl") ?? "http://localhost:4434";
    using var httpClient = new HttpClient();

    var payload = new
    {
        schema_id = "default",
        traits = new { email = request.Email.Trim() },
        state = "inactive",
        credentials = new
        {
            password = new { config = new { password = Guid.NewGuid().ToString() } }
        }
    };

    var response = await httpClient.PostAsJsonAsync($"{kratosAdminUrl}/admin/identities", payload);

    if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
        return Results.Conflict(new { error = "An account with this email already exists" });

    if (!response.IsSuccessStatusCode)
    {
        var body = await response.Content.ReadAsStringAsync();
        return Results.Problem($"Failed to create identity: {body}");
    }

    return Results.Ok(new { message = "Access request submitted. An admin will review your request." });
})
.WithName("Signup");

app.MapMetrics();

app.Run();
