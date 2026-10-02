import { component$ } from '@builder.io/qwik';
import { QwikCityProvider, RouterOutlet } from '@builder.io/qwik-city';
import { useQwikSpeak } from 'qwik-speak';
import './global.css';

const speakConfig = {
  defaultLocale: { lang: 'zh-CN', currency: 'CNY', timeZone: 'Asia/Shanghai' },
  supportedLocales: [
    { lang: 'zh-CN', currency: 'CNY', timeZone: 'Asia/Shanghai' },
    { lang: 'en-US', currency: 'USD', timeZone: 'UTC' }
  ],
  assets: []
};

export default component$(() => {
  useQwikSpeak({ config: speakConfig });
  return (
    <QwikCityProvider>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>国际会议同声传译控制台</title>
      </head>
      <body><RouterOutlet /></body>
    </QwikCityProvider>
  );
});
