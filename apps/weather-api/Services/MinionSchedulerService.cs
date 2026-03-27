using Cronos;
using WeatherApi.Models;
using WeatherApi.Repositories;

namespace WeatherApi.Services;

public class MinionSchedulerService(
    IServiceScopeFactory scopeFactory,
    ILogger<MinionSchedulerService> logger) : BackgroundService
{
    private static readonly string[] Summaries =
    [
        "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
    ];

    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("MinionSchedulerService started, ticking every {Interval}s", TickInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ProcessActiveMinions(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Error in minion scheduler tick");
            }

            await Task.Delay(TickInterval, stoppingToken);
        }
    }

    private async Task ProcessActiveMinions(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var minionRepo = scope.ServiceProvider.GetRequiredService<IMinionRepository>();
        var forecastRepo = scope.ServiceProvider.GetRequiredService<IWeatherForecastRepository>();

        var activeMinions = await minionRepo.GetActiveAsync();

        foreach (var minion in activeMinions)
        {
            if (ct.IsCancellationRequested) break;

            try
            {
                if (ShouldRun(minion))
                {
                    var forecast = GenerateRandomForecast(minion.Name);
                    await forecastRepo.CreateAsync(forecast);
                    await minionRepo.UpdateLastRunAsync(minion.Id, DateTime.UtcNow);
                    logger.LogInformation("Minion '{Name}' (id={Id}) created forecast: {Summary} {TempC}°C",
                        minion.Name, minion.Id, forecast.Summary, forecast.TemperatureC);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Minion '{Name}' (id={Id}) failed to execute", minion.Name, minion.Id);
            }
        }
    }

    private static bool ShouldRun(Minion minion)
    {
        var now = DateTime.UtcNow;

        return minion.ScheduleType switch
        {
            ScheduleType.Interval => ShouldRunInterval(minion, now),
            ScheduleType.Cron => ShouldRunCron(minion, now),
            ScheduleType.DailyAt => ShouldRunDailyAt(minion, now),
            _ => false
        };
    }

    private static bool ShouldRunInterval(Minion minion, DateTime now)
    {
        if (!int.TryParse(minion.ScheduleValue, out var minutes) || minutes <= 0)
            return false;

        var lastRun = minion.LastRunAt ?? minion.CreatedAt;
        return now - lastRun >= TimeSpan.FromMinutes(minutes);
    }

    private static bool ShouldRunCron(Minion minion, DateTime now)
    {
        try
        {
            var expression = CronExpression.Parse(minion.ScheduleValue);
            var lastRun = minion.LastRunAt ?? minion.CreatedAt;
            var nextOccurrence = expression.GetNextOccurrence(lastRun, inclusive: false);
            return nextOccurrence.HasValue && nextOccurrence.Value <= now;
        }
        catch
        {
            return false;
        }
    }

    private static bool ShouldRunDailyAt(Minion minion, DateTime now)
    {
        if (!TimeOnly.TryParse(minion.ScheduleValue, out var targetTime))
            return false;

        var todayTarget = now.Date.Add(targetTime.ToTimeSpan());
        var lastRun = minion.LastRunAt ?? DateTime.MinValue;

        return now >= todayTarget && lastRun < todayTarget;
    }

    private static WeatherForecast GenerateRandomForecast(string minionName)
    {
        return new WeatherForecast
        {
            Date = DateOnly.FromDateTime(DateTime.Now.AddDays(Random.Shared.Next(1, 10))),
            TemperatureC = Random.Shared.Next(-20, 55),
            Summary = $"[Minion: {minionName}] {Summaries[Random.Shared.Next(Summaries.Length)]}"
        };
    }
}
