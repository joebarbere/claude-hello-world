using WeatherApi.Models;

namespace WeatherApi.Tests;

public class WeatherForecastModelTests
{
    [Theory]
    [InlineData(0, 32)]
    [InlineData(100, 211)]
    [InlineData(-40, -39)]
    [InlineData(37, 98)]
    public void TemperatureF_ConvertsFromCelsius(int celsius, int expectedFahrenheit)
    {
        // Formula: 32 + (int)(TemperatureC / 0.5556)
        var forecast = new WeatherForecast { TemperatureC = celsius };
        Assert.Equal(expectedFahrenheit, forecast.TemperatureF);
    }

    [Fact]
    public void Properties_CanBeSetAndRead()
    {
        var date = new DateOnly(2026, 3, 14);
        var forecast = new WeatherForecast
        {
            Id = 42,
            Date = date,
            TemperatureC = 25,
            Summary = "Warm"
        };

        Assert.Equal(42, forecast.Id);
        Assert.Equal(date, forecast.Date);
        Assert.Equal(25, forecast.TemperatureC);
        Assert.Equal("Warm", forecast.Summary);
    }

    [Fact]
    public void Summary_IsNullable()
    {
        var forecast = new WeatherForecast();
        Assert.Null(forecast.Summary);
    }
}
