import { useEffect, useRef } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { themes, applyCustomTheme, Palette } from '@/styles/themes';

type UseThemeProps = {
  systemUIVisible?: boolean;
  appThemeColor?: keyof Palette;
};

export const useTheme = ({ appThemeColor = 'base-100' }: UseThemeProps = {}) => {
  const { settings } = useSettingsStore();
  const isEink = settings?.globalViewSettings?.isEink;
  const isColorEink = settings?.globalViewSettings?.isColorEink;
  const isBwEink = isEink && !isColorEink;
  const highlightOpacity = settings?.globalViewSettings?.highlightOpacity ?? 0.4;
  const { themeColor, isDarkMode, updateAppTheme } = useThemeStore();

  const useFallbackColors = useRef(false);

  useEffect(() => {
    updateAppTheme(appThemeColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appThemeColor]);

  useEffect(() => {
    if (!themeColor || !themes.find((t) => t.name === themeColor)) return;
    if (useFallbackColors.current) {
      applyCustomTheme(undefined, themeColor, true);
    }
  }, [themeColor]);

  useEffect(() => {
    const customThemes = settings.globalReadSettings?.customThemes ?? [];
    customThemes.forEach((customTheme) => {
      applyCustomTheme(customTheme, undefined, useFallbackColors.current);
    });
    localStorage.setItem('customThemes', JSON.stringify(customThemes));
  }, [settings.globalReadSettings?.customThemes]);

  useEffect(() => {
    const colorScheme = isDarkMode ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', `${themeColor}-${colorScheme}`);
    document.documentElement.style.setProperty('color-scheme', colorScheme);
    document.documentElement.style.setProperty('--scroll-bg-opacity', isBwEink ? '1.0' : '0.5');
    document.documentElement.style.setProperty(
      '--overlayer-highlight-opacity',
      isBwEink ? '1.0' : String(highlightOpacity),
    );
    document.documentElement.style.setProperty(
      '--overlayer-highlight-blend-mode',
      isBwEink ? 'difference' : isDarkMode ? 'screen' : 'multiply',
    );
    // 搜索匹配遮罩颜色：主题自适应。浅色琥珀黄（multiply 混合在浅底变暗）、
    // 深色浅琥珀（screen 混合在深底提亮），由 foliate Overlayer.highlight 的
    // var(--search-highlight-color) 引用；透明度随 --overlayer-highlight-opacity。
    document.documentElement.style.setProperty(
      '--search-highlight-color',
      isDarkMode ? '#f59e0b' : '#fbbf24',
    );
    document.documentElement.style.setProperty(
      '--bg-texture-blend-mode',
      isDarkMode ? 'lighten' : 'multiply',
    );
  }, [themeColor, isDarkMode, isBwEink, highlightOpacity]);
};
