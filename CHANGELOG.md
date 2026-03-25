# 변경 이력

## 2026-03-25
- GitHub Pages 검증 실패 원인이던 `_tabs/categories.md`, `_tabs/tags.md` 누락을 복원했습니다.
- 카테고리/태그 상세 페이지에서 상위 `/categories/`, `/tags/` 링크가 깨지던 문제를 해결했습니다.
- 협업 기록 `AGENT_COLLAB_LOG.md`에 배포 오류 원인과 수정 내용을 정리했습니다.
- 로컬 `htmlproofer`는 Windows `libcurl` DLL 누락으로 실행되지 않아, 생성된 `_site` 결과를 수동 확인했습니다.
- 사이드바에서는 `분류` 탭만 남기고, 중복되던 `카테고리`/`태그` 탭은 숨겼습니다. 실제 `/categories/`, `/tags/` 페이지는 유지됩니다.
