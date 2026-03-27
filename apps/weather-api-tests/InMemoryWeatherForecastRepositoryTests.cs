using WeatherApi.Models;
using WeatherApi.Repositories;

namespace WeatherApi.Tests;

public class InMemoryWeatherForecastRepositoryTests
{
    private readonly InMemoryWeatherForecastRepository _repo = new();

    [Fact]
    public async Task GetAllAsync_ReturnsEmpty_WhenNoItems()
    {
        var result = await _repo.GetAllAsync();
        Assert.Empty(result);
    }

    [Fact]
    public async Task CreateAsync_AssignsIdAndStoresItem()
    {
        var forecast = new WeatherForecast
        {
            Date = new DateOnly(2026, 1, 1),
            TemperatureC = 10,
            Summary = "Cool"
        };

        var created = await _repo.CreateAsync(forecast);

        Assert.Equal(1, created.Id);
        var all = await _repo.GetAllAsync();
        Assert.Single(all);
    }

    [Fact]
    public async Task CreateAsync_IncrementsId()
    {
        await _repo.CreateAsync(new WeatherForecast { Date = new DateOnly(2026, 1, 1), TemperatureC = 10 });
        var second = await _repo.CreateAsync(new WeatherForecast { Date = new DateOnly(2026, 1, 2), TemperatureC = 20 });

        Assert.Equal(2, second.Id);
    }

    [Fact]
    public async Task GetByIdAsync_ReturnsItem_WhenExists()
    {
        var created = await _repo.CreateAsync(new WeatherForecast
        {
            Date = new DateOnly(2026, 1, 1),
            TemperatureC = 15,
            Summary = "Mild"
        });

        var result = await _repo.GetByIdAsync(created.Id);

        Assert.NotNull(result);
        Assert.Equal("Mild", result.Summary);
    }

    [Fact]
    public async Task GetByIdAsync_ReturnsNull_WhenNotFound()
    {
        var result = await _repo.GetByIdAsync(999);
        Assert.Null(result);
    }

    [Fact]
    public async Task UpdateAsync_UpdatesFields_WhenExists()
    {
        var created = await _repo.CreateAsync(new WeatherForecast
        {
            Date = new DateOnly(2026, 1, 1),
            TemperatureC = 10,
            Summary = "Cool"
        });

        var updated = await _repo.UpdateAsync(created.Id, new WeatherForecast
        {
            Date = new DateOnly(2026, 6, 1),
            TemperatureC = 30,
            Summary = "Hot"
        });

        Assert.NotNull(updated);
        Assert.Equal(new DateOnly(2026, 6, 1), updated.Date);
        Assert.Equal(30, updated.TemperatureC);
        Assert.Equal("Hot", updated.Summary);
    }

    [Fact]
    public async Task UpdateAsync_ReturnsNull_WhenNotFound()
    {
        var result = await _repo.UpdateAsync(999, new WeatherForecast());
        Assert.Null(result);
    }

    [Fact]
    public async Task DeleteAsync_ReturnsTrue_WhenExists()
    {
        var created = await _repo.CreateAsync(new WeatherForecast
        {
            Date = new DateOnly(2026, 1, 1),
            TemperatureC = 10
        });

        var deleted = await _repo.DeleteAsync(created.Id);

        Assert.True(deleted);
        var all = await _repo.GetAllAsync();
        Assert.Empty(all);
    }

    [Fact]
    public async Task DeleteAsync_ReturnsFalse_WhenNotFound()
    {
        var result = await _repo.DeleteAsync(999);
        Assert.False(result);
    }

    [Fact]
    public async Task GetAllAsync_ReturnsSnapshot_NotLiveReference()
    {
        await _repo.CreateAsync(new WeatherForecast { Date = new DateOnly(2026, 1, 1), TemperatureC = 10 });
        var snapshot = (await _repo.GetAllAsync()).ToList();

        await _repo.CreateAsync(new WeatherForecast { Date = new DateOnly(2026, 1, 2), TemperatureC = 20 });

        Assert.Single(snapshot);
    }
}
