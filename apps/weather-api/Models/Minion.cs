using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace WeatherApi.Models;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ScheduleType
{
    Interval,
    Cron,
    DailyAt
}

public class Minion
{
    public int Id { get; set; }

    [Required]
    [MaxLength(100)]
    public string Name { get; set; } = string.Empty;

    [Required]
    public ScheduleType ScheduleType { get; set; }

    [Required]
    [MaxLength(100)]
    public string ScheduleValue { get; set; } = string.Empty;

    public bool IsActive { get; set; }

    public DateTime? LastRunAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
