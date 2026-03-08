using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace WeatherApi.Models;

public class WeatherForecast
{
    public int Id { get; set; }

    [Required]
    public DateOnly Date { get; set; }

    public int TemperatureC { get; set; }

    public string? Summary { get; set; }

    [NotMapped]
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
