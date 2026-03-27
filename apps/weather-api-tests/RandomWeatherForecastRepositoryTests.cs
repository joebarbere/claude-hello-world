using WeatherApi.Repositories;

namespace WeatherApi.Tests;

public class RandomWeatherForecastRepositoryTests
{
    private readonly RandomWeatherForecastRepository _repo = new();

    [Fact]
    public async Task GetAllAsync_ReturnsFiveForecasts()
    {
        var result = (await _repo.GetAllAsync()).ToList();
        Assert.Equal(5, result.Count);
    }

    [Fact]
    public async Task GetAllAsync_ForecastsHaveSequentialIds()
    {
        var result = (await _repo.GetAllAsync()).ToList();
        for (int i = 0; i < result.Count; i++)
        {
            Assert.Equal(i + 1, result[i].Id);
        }
    }

    [Fact]
    public async Task GetAllAsync_ForecastsHaveFutureDates()
    {
        var result = (await _repo.GetAllAsync()).ToList();
        var today = DateOnly.FromDateTime(DateTime.Now);
        foreach (var forecast in result)
        {
            Assert.True(forecast.Date > today);
        }
    }

    [Fact]
    public async Task GetAllAsync_ForecastsHaveSummaries()
    {
        var result = (await _repo.GetAllAsync()).ToList();
        foreach (var forecast in result)
        {
            Assert.NotNull(forecast.Summary);
            Assert.NotEmpty(forecast.Summary);
        }
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(5)]
    public async Task GetByIdAsync_ReturnsForecast_WhenValidId(int id)
    {
        var result = await _repo.GetByIdAsync(id);
        Assert.NotNull(result);
        Assert.Equal(id, result.Id);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(6)]
    [InlineData(100)]
    public async Task GetByIdAsync_ReturnsNull_WhenInvalidId(int id)
    {
        var result = await _repo.GetByIdAsync(id);
        Assert.Null(result);
    }

    [Fact]
    public async Task CreateAsync_ThrowsNotSupportedException()
    {
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            _repo.CreateAsync(new WeatherApi.Models.WeatherForecast()));
    }

    [Fact]
    public async Task UpdateAsync_ThrowsNotSupportedException()
    {
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            _repo.UpdateAsync(1, new WeatherApi.Models.WeatherForecast()));
    }

    [Fact]
    public async Task DeleteAsync_ThrowsNotSupportedException()
    {
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            _repo.DeleteAsync(1));
    }
}
