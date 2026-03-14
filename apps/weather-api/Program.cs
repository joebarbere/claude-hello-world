using Microsoft.EntityFrameworkCore;
using Prometheus;
using Scalar.AspNetCore;
using WeatherApi.Data;
using WeatherApi.Middleware;
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

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}

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

app.MapMetrics();

app.Run();
