const CONTENT_PILLARS = {
  INDUSTRY_INSIGHT: { weight: 0.35, label: 'Industry Insight', color: '#2563eb' },
  TACTICAL_HOWTO: { weight: 0.25, label: 'Tactical How-To', color: '#059669' },
  SOCIAL_PROOF: { weight: 0.20, label: 'Social Proof', color: '#d97706' },
  HOT_TAKE: { weight: 0.10, label: 'Hot Take', color: '#dc2626' },
  BEHIND_SCENES: { weight: 0.10, label: 'Behind the Scenes', color: '#7c3aed' }
};

const CATEGORY_TO_PILLAR = {
  DATA_POINT: 'INDUSTRY_INSIGHT',
  NEWS: 'INDUSTRY_INSIGHT',
  QUESTION: 'TACTICAL_HOWTO',
  PAIN_POINT: 'TACTICAL_HOWTO',
  CLIENT_WIN: 'SOCIAL_PROOF',
  CONTENT_PIECE: 'HOT_TAKE'
};

const TIME_SLOTS = ['morning', 'midday', 'evening'];
const PLATFORMS = ['linkedin', 'x', 'video', 'blog', 'email', 'youtube'];

const PILLAR_ROTATION = [
  'INDUSTRY_INSIGHT',  // Mon
  'TACTICAL_HOWTO',    // Tue
  'SOCIAL_PROOF',      // Wed
  'INDUSTRY_INSIGHT',  // Thu
  'HOT_TAKE',          // Fri
  'BEHIND_SCENES',     // Sat
  'TACTICAL_HOWTO'     // Sun
];

function getPillar(category) {
  return CATEGORY_TO_PILLAR[category] || 'INDUSTRY_INSIGHT';
}

// Build calendar for a full month (or current week as fallback)
function buildMonthlyCalendar(contentItems, yearMonth, calendarData) {
  // yearMonth format: "2026-02"
  const now = new Date();
  let year, month;

  if (yearMonth) {
    const parts = yearMonth.split('-');
    year = parseInt(parts[0]);
    month = parseInt(parts[1]) - 1; // 0-indexed
  } else {
    year = now.getFullYear();
    month = now.getMonth();
  }

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();

  // Saved calendar assignments (from calendarData)
  const saved = calendarData || {};

  const days = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const key = date.toISOString().split('T')[0];
    const dayOfWeek = date.getDay(); // 0=Sun
    const pillarIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0, Sun=6

    // Build slots from saved data
    const slots = {};
    for (const platform of PLATFORMS) {
      for (const time of TIME_SLOTS) {
        const slotKey = `${platform}_${time}`;
        slots[slotKey] = saved[key]?.[slotKey] || null;
      }
    }

    const isToday = key === now.toISOString().split('T')[0];
    const isPast = date < new Date(now.toISOString().split('T')[0]);

    days.push({
      date: key,
      day: dayNames[dayOfWeek],
      dayOfWeek,
      dayNum: d,
      isToday,
      isPast,
      pillar: PILLAR_ROTATION[pillarIdx],
      pillar_label: CONTENT_PILLARS[PILLAR_ROTATION[pillarIdx]]?.label || 'General',
      pillar_color: CONTENT_PILLARS[PILLAR_ROTATION[pillarIdx]]?.color || '#666',
      slots
    });
  }

  // Calculate coverage stats
  let filledSlots = 0;
  let totalSlots = 0;
  for (const day of days) {
    if (day.isPast) continue; // Don't count past days
    for (const key of Object.keys(day.slots)) {
      totalSlots++;
      if (day.slots[key]) filledSlots++;
    }
  }

  // Platform coverage per week
  const weeks = [];
  let weekStart = null;
  let weekDays = [];
  for (const day of days) {
    if (day.dayOfWeek === 1 || weekDays.length === 0) {
      if (weekDays.length > 0) {
        weeks.push({ start: weekStart, days: weekDays });
      }
      weekStart = day.date;
      weekDays = [day];
    } else {
      weekDays.push(day);
    }
  }
  if (weekDays.length > 0) {
    weeks.push({ start: weekStart, days: weekDays });
  }

  // Weekly platform coverage
  const weeklyStats = weeks.map(week => {
    const platformCoverage = {};
    for (const platform of PLATFORMS) {
      let filled = 0;
      let total = 0;
      for (const day of week.days) {
        for (const time of TIME_SLOTS) {
          total++;
          if (day.slots[`${platform}_${time}`]) filled++;
        }
      }
      platformCoverage[platform] = { filled, total, pct: total > 0 ? Math.round((filled / total) * 100) : 0 };
    }
    return { start: week.start, end: week.days[week.days.length - 1].date, platformCoverage };
  });

  return {
    year,
    month: month + 1,
    month_name: firstDay.toLocaleString('en-US', { month: 'long' }),
    days,
    weeks,
    weeklyStats,
    stats: {
      filled_slots: filledSlots,
      total_slots: totalSlots,
      coverage: totalSlots > 0 ? Math.round((filledSlots / totalSlots) * 100) : 0,
      days_in_month: daysInMonth
    },
    platforms: PLATFORMS,
    time_slots: TIME_SLOTS
  };
}

// Auto-fill a week with approved content
function autoFillWeek(contentItems, weekStartDate, calendarData) {
  const saved = calendarData || {};
  const weekStart = new Date(weekStartDate);

  // Get 7 days from start
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    weekDates.push(d.toISOString().split('T')[0]);
  }

  // Get eligible content: approved first, then review
  const eligible = contentItems
    .filter(c => c.status === 'approved' || c.status === 'review')
    .sort((a, b) => {
      // Approved first, then by quality score, then by date
      if (a.status !== b.status) return a.status === 'approved' ? -1 : 1;
      const aVals = a.quality_scores ? Object.values(a.quality_scores).map(q => q?.score || 0) : [];
      const aScore = aVals.length > 0 ? Math.max(...aVals) : 0;
      const bVals = b.quality_scores ? Object.values(b.quality_scores).map(q => q?.score || 0) : [];
      const bScore = bVals.length > 0 ? Math.max(...bVals) : 0;
      if (aScore !== bScore) return bScore - aScore;
      return new Date(b.generated_at) - new Date(a.generated_at);
    });

  // Already-scheduled content IDs (to avoid double-booking)
  const scheduledIds = new Set();
  for (const dateKey of Object.keys(saved)) {
    for (const slot of Object.values(saved[dateKey] || {})) {
      if (slot?.content_id) scheduledIds.add(slot.content_id);
    }
  }

  // Format-to-platform mapping
  const formatToPlatform = {
    linkedin: 'linkedin', carousel: 'linkedin', poll: 'linkedin',
    quote_cards: 'linkedin', listicle: 'linkedin', hot_take: 'linkedin',
    before_after: 'linkedin', stat_graphic: 'linkedin',
    x_single: 'x', x_thread: 'x',
    short_video: 'video',
    blog: 'blog', case_study: 'blog',
    newsletter: 'email', lead_magnet: 'email',
    youtube_script: 'youtube'
  };

  // Preferred time slots per platform
  const platformTimePrefs = {
    linkedin: ['morning', 'midday'],
    x: ['morning', 'midday', 'evening'],
    video: ['midday'],
    blog: ['morning'],
    email: ['morning'],
    youtube: ['midday']
  };

  const assignments = {};
  let assigned = 0;

  for (const item of eligible) {
    if (scheduledIds.has(item.id)) continue;

    // Find available formats with content
    const availableFormats = Object.entries(item.formats || {})
      .filter(([, fmt]) => fmt.content && fmt.status !== 'rejected')
      .map(([key]) => key);

    if (availableFormats.length === 0) continue;

    for (const format of availableFormats) {
      const platform = formatToPlatform[format];
      if (!platform) continue;

      const preferredTimes = platformTimePrefs[platform] || ['morning'];

      // Try to place in an empty slot for the week
      let placed = false;
      for (const dateKey of weekDates) {
        if (placed) break;
        for (const time of preferredTimes) {
          const slotKey = `${platform}_${time}`;
          const existing = saved[dateKey]?.[slotKey] || assignments[dateKey]?.[slotKey];
          if (!existing) {
            if (!assignments[dateKey]) assignments[dateKey] = {};
            assignments[dateKey][slotKey] = {
              content_id: item.id,
              format,
              title: (item.trigger_title || '').slice(0, 60),
              status: item.formats[format].status,
              preview: typeof item.formats[format].content === 'string'
                ? item.formats[format].content.slice(0, 80) + '...'
                : format
            };
            placed = true;
            assigned++;
            break;
          }
        }
      }

      if (placed) {
        scheduledIds.add(item.id);
        break; // One placement per content item
      }
    }
  }

  return { assignments, assigned };
}

// Legacy: build weekly calendar (backwards compat for existing API)
function buildWeeklyCalendar(contentItems) {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - dayOfWeek + 1); // Monday
  startOfWeek.setHours(0, 0, 0, 0);

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const calendar = {};

  for (let i = 0; i < 7; i++) {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + i);
    const key = date.toISOString().split('T')[0];
    calendar[key] = {
      day: days[i],
      date: key,
      slots: {
        linkedin: null,
        x: null,
        video: null,
        blog: null,
        youtube: null
      },
      pillar: null
    };
  }

  const dates = Object.keys(calendar).sort();
  dates.forEach((date, i) => {
    calendar[date].pillar = PILLAR_ROTATION[i];
    calendar[date].pillar_label = CONTENT_PILLARS[PILLAR_ROTATION[i]]?.label || 'General';
    calendar[date].pillar_color = CONTENT_PILLARS[PILLAR_ROTATION[i]]?.color || '#666';
  });

  const eligible = contentItems
    .filter(c => c.status === 'approved' || c.status === 'review')
    .sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));

  let contentIndex = 0;
  for (const date of dates) {
    if (contentIndex >= eligible.length) break;
    const item = eligible[contentIndex];
    const cal = calendar[date];

    if (item.formats?.linkedin?.content) {
      cal.slots.linkedin = {
        content_id: item.id,
        title: item.trigger_title,
        status: item.formats.linkedin.status,
        preview: item.formats.linkedin.content?.slice(0, 100) + '...'
      };
    }
    if (item.formats?.x_single?.content || item.formats?.x_thread?.content) {
      cal.slots.x = {
        content_id: item.id,
        title: item.trigger_title,
        status: (item.formats.x_single?.status === 'approved' || item.formats.x_thread?.status === 'approved') ? 'approved' : 'review',
        preview: (item.formats.x_single?.content || item.formats.x_thread?.content?.[0] || '').slice(0, 100) + '...'
      };
    }
    if (item.formats?.short_video?.content) {
      cal.slots.video = {
        content_id: item.id,
        title: item.trigger_title,
        status: item.formats.short_video.status,
        preview: item.formats.short_video.content?.slice(0, 100) + '...'
      };
    }
    if (item.formats?.blog?.content) {
      cal.slots.blog = {
        content_id: item.id,
        title: item.trigger_title,
        status: item.formats.blog.status
      };
    }
    if (item.formats?.youtube_script?.content) {
      cal.slots.youtube = {
        content_id: item.id,
        title: item.trigger_title,
        status: item.formats.youtube_script.status
      };
    }

    contentIndex++;
  }

  return {
    week_start: dates[0],
    week_end: dates[dates.length - 1],
    days: Object.values(calendar),
    stats: {
      filled_slots: Object.values(calendar).reduce((sum, day) => {
        return sum + Object.values(day.slots || {}).filter(Boolean).length;
      }, 0),
      total_slots: 7 * 5,
      coverage: Math.round(
        (Object.values(calendar).reduce((sum, day) => {
          return sum + Object.values(day.slots || {}).filter(Boolean).length;
        }, 0) / 35) * 100
      )
    }
  };
}

// Smart auto-fill: uses performance data + predictions to pick best content for each slot
function smartAutoFillWeek(contentItems, weekStartDate, calendarData, perfData) {
  const saved = calendarData || {};
  const weekStart = new Date(weekStartDate);
  const performance = perfData || [];

  const weekDates = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    weekDates.push({ date: d.toISOString().split('T')[0], dayName: dayNames[d.getDay()].toLowerCase() });
  }

  // Build performance-based day+platform scoring
  const dayPlatformScore = {};
  for (const p of performance) {
    if (!p.published_at) continue;
    const day = new Date(p.published_at).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const platform = p.format || 'linkedin';
    const key = `${day}_${platform}`;
    if (!dayPlatformScore[key]) dayPlatformScore[key] = { total: 0, engagement: 0 };
    dayPlatformScore[key].total++;
    dayPlatformScore[key].engagement += (p.engagement || 0);
  }

  // Get eligible content with smart scoring
  const eligible = contentItems
    .filter(c => c.status === 'approved' || c.status === 'review')
    .map(c => {
      const prediction = c.predictions?.linkedin;
      const tierScore = { exceptional: 4, high: 3, moderate: 2, low: 1 };
      const predScore = prediction ? (tierScore[prediction.predicted_engagement_tier] || 2) : 2;
      const qualityScore = c.quality_score?.score || 50;
      const statusBoost = c.status === 'approved' ? 20 : 0;
      return { ...c, _smartScore: predScore * 10 + qualityScore + statusBoost };
    })
    .sort((a, b) => b._smartScore - a._smartScore);

  const scheduledIds = new Set();
  for (const dateKey of Object.keys(saved)) {
    for (const slot of Object.values(saved[dateKey] || {})) {
      if (slot?.content_id) scheduledIds.add(slot.content_id);
    }
  }

  const formatToPlatform = {
    linkedin: 'linkedin', carousel: 'linkedin', poll: 'linkedin',
    quote_cards: 'linkedin', listicle: 'linkedin', hot_take: 'linkedin',
    before_after: 'linkedin', stat_graphic: 'linkedin',
    x_single: 'x', x_thread: 'x',
    short_video: 'video',
    blog: 'blog', case_study: 'blog',
    newsletter: 'email', lead_magnet: 'email',
    youtube_script: 'youtube'
  };

  // Best time slots based on performance data + research defaults
  const bestSlots = {
    linkedin: { morning: 3, midday: 2, evening: 0 },
    x: { morning: 2, midday: 2, evening: 1 },
    video: { morning: 1, midday: 3, evening: 2 },
    blog: { morning: 3, midday: 1, evening: 0 },
    email: { morning: 3, midday: 0, evening: 0 },
    youtube: { midday: 2, morning: 1, evening: 1 }
  };

  // Best days from research
  const bestDays = {
    linkedin: { tuesday: 3, wednesday: 3, thursday: 2, monday: 1, friday: 1 },
    x: { tuesday: 2, wednesday: 2, thursday: 2, monday: 1, friday: 1 },
    video: { monday: 2, thursday: 2, saturday: 1 },
    blog: { tuesday: 3, wednesday: 2, thursday: 1 },
    email: { tuesday: 3, thursday: 2, wednesday: 1 },
    youtube: { tuesday: 2, thursday: 2, saturday: 2 }
  };

  const assignments = {};
  let assigned = 0;
  const usedCategories = {}; // Track categories per day for variety

  // Sort content by smart score, then assign to best available slots
  for (const item of eligible) {
    if (scheduledIds.has(item.id)) continue;

    const availableFormats = Object.entries(item.formats || {})
      .filter(([, fmt]) => fmt.content && fmt.status !== 'rejected')
      .map(([key]) => key);

    if (availableFormats.length === 0) continue;

    // Score each possible slot placement
    let bestPlacement = null;
    let bestScore = -1;

    for (const format of availableFormats) {
      const platform = formatToPlatform[format];
      if (!platform) continue;

      for (const { date: dateKey, dayName } of weekDates) {
        for (const time of TIME_SLOTS) {
          const slotKey = `${platform}_${time}`;
          if (saved[dateKey]?.[slotKey] || assignments[dateKey]?.[slotKey]) continue;

          // Score this placement
          let slotScore = 0;
          slotScore += (bestSlots[platform]?.[time] || 0) * 2;
          slotScore += (bestDays[platform]?.[dayName] || 0) * 3;

          // Performance data boost
          const perfKey = `${dayName}_${platform}`;
          const perf = dayPlatformScore[perfKey];
          if (perf && perf.total >= 2) {
            slotScore += Math.min(perf.engagement / perf.total, 5);
          }

          // Category variety bonus — avoid same category twice on same day
          const category = item.trigger_category || 'unknown';
          const dayCats = usedCategories[dateKey] || {};
          if (!dayCats[category]) slotScore += 2;

          if (slotScore > bestScore) {
            bestScore = slotScore;
            bestPlacement = { dateKey, slotKey, format, platform };
          }
        }
      }
    }

    if (bestPlacement) {
      const { dateKey, slotKey, format } = bestPlacement;
      if (!assignments[dateKey]) assignments[dateKey] = {};
      assignments[dateKey][slotKey] = {
        content_id: item.id,
        format,
        title: (item.trigger_title || '').slice(0, 60),
        status: item.formats[format].status,
        smart_score: Math.round(bestScore),
        preview: typeof item.formats[format].content === 'string'
          ? item.formats[format].content.slice(0, 80) + '...'
          : format
      };
      scheduledIds.add(item.id);
      assigned++;

      // Track category usage
      if (!usedCategories[dateKey]) usedCategories[dateKey] = {};
      usedCategories[dateKey][item.trigger_category || 'unknown'] = true;
    }
  }

  return { assignments, assigned, method: 'smart' };
}

module.exports = { buildWeeklyCalendar, buildMonthlyCalendar, autoFillWeek, smartAutoFillWeek, CONTENT_PILLARS, getPillar, TIME_SLOTS, PLATFORMS };
