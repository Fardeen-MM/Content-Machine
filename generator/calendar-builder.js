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

function getPillar(category) {
  return CATEGORY_TO_PILLAR[category] || 'INDUSTRY_INSIGHT';
}

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

  // Assign pillar targets for each day
  const pillarRotation = [
    'INDUSTRY_INSIGHT',  // Mon
    'TACTICAL_HOWTO',    // Tue
    'SOCIAL_PROOF',      // Wed
    'INDUSTRY_INSIGHT',  // Thu
    'HOT_TAKE',          // Fri
    'BEHIND_SCENES',     // Sat
    'TACTICAL_HOWTO'     // Sun
  ];

  const dates = Object.keys(calendar).sort();
  dates.forEach((date, i) => {
    calendar[date].pillar = pillarRotation[i];
    calendar[date].pillar_label = CONTENT_PILLARS[pillarRotation[i]]?.label || 'General';
    calendar[date].pillar_color = CONTENT_PILLARS[pillarRotation[i]]?.color || '#666';
  });

  // Fill approved/review content into calendar slots
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
        return sum + Object.values(day.slots).filter(Boolean).length;
      }, 0),
      total_slots: 7 * 5,
      coverage: Math.round(
        (Object.values(calendar).reduce((sum, day) => {
          return sum + Object.values(day.slots).filter(Boolean).length;
        }, 0) / 35) * 100
      )
    }
  };
}

module.exports = { buildWeeklyCalendar, CONTENT_PILLARS, getPillar };
