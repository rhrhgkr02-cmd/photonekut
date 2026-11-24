/* =========================================================
   🔑 설정 파일 (선생님이 수정하는 유일한 파일)
   ---------------------------------------------------------
   ▶ 부스 모드 (기본, 설정 필요 없음)
     부스에 둔 노트북/태블릿 한 대에서 학생이 찍고 보내면,
     같은 기기의 [선생님 모드]에 사진이 쌓여요. 거기서 다운로드·인쇄.
     BOOTH_PASSWORD 만 원하는 숫자로 바꿔 주세요.

   ▶ 휴대폰 모드 (선택)
     학생들이 각자 휴대폰으로 접속해서 보내려면
     설치가이드 'B'를 따라 Apps Script 주소를 APPS_SCRIPT_URL 에 붙여넣으세요.
   ========================================================= */
window.PHOTOBOOTH_CONFIG = {
  BOOTH_PASSWORD: "0000",   // 부스 모드 선생님 비밀번호
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzbnWQLcQgz70-GinltS4jFjIwl3WERGzgsMEjJJkK6bd3fxpW5yE9812jCk5yHotdrNA/exec"       // (선택) 휴대폰 모드용 주소. 비워 두면 부스 모드
};
