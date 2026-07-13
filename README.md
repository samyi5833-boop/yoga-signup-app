# 요가동호회 수업 신청 앱 — 무료 배포 가이드 (개발자 없이 직접 하는 버전)

카톡 오픈채팅방에 링크를 올리면, 회원들이 각자 스마트폰 브라우저로 접속해 신청/취소할 수 있는 앱입니다.
**신용카드 없이, 무료 서비스 2개(GitHub + MongoDB Atlas + Render)만 가입하면 됩니다.** 소요 시간은 전체 20~30분 정도예요.

---

## 왜 서비스가 3개나 필요한가요?
- **GitHub**: 코드를 올려두는 곳 (Render가 여기서 코드를 가져가서 실행해요)
- **Render**: 실제로 앱을 인터넷에 띄워서 주소(URL)를 만들어주는 곳
- **MongoDB Atlas**: 신청자 명단이 안전하게 저장되는 곳 (Render는 무료로 쓰면 서버가 주기적으로 잠들면서 자체 저장 파일을 날려버리기 때문에, 명단은 따로 저장해야 해요)

---

## 1단계. GitHub에 코드 올리기 (5분)
1. https://github.com 접속 → 우측 상단 **Sign up** 으로 무료 계정 생성 (이메일만 있으면 됨)
2. 로그인 후 우측 상단 **+** → **New repository** 클릭
3. Repository name에 `yoga-signup-app` 입력 → **Public** 선택 → **Create repository**
4. 만들어진 빈 저장소 화면에서 **uploading an existing file** 링크 클릭
5. 이 zip 파일의 압축을 풀고, **`node_modules` 폴더만 빼고** 나머지 전부(폴더 구조 그대로: `public` 폴더, `server.js`, `storage.js`, `package.json` 등)를 그 업로드 화면에 드래그 앤 드롭
6. 아래 **Commit changes** 클릭

---

## 2단계. MongoDB Atlas 무료 데이터베이스 만들기 (10분)
1. https://www.mongodb.com/cloud/atlas/register 접속 → 이메일로 무료 가입
2. 처음 화면에서 **Create a deployment(클러스터 생성)** → **M0 (Free)** 선택 그대로 두고 **Create**
3. **Database User** 만들기: 아이디/비밀번호 직접 입력 (예: `yogaadmin` / 임의의 안전한 비밀번호) → 이 비밀번호는 따로 메모해두세요
4. **Network Access(IP 접근 허용)** 단계에서 **Allow access from anywhere (0.0.0.0/0)** 선택 → Confirm
   (Render의 서버 주소가 매번 바뀔 수 있어서, 무료 단계에서는 이 설정이 제일 간단해요)
5. 클러스터가 다 만들어지면 **Connect** → **Drivers** 선택 → Node.js용 연결 문자열(`mongodb+srv://...`)을 복사
   - 문자열 안의 `<password>` 부분을 3번에서 만든 실제 비밀번호로 바꿔주세요
   - 예: `mongodb+srv://yogaadmin:여기에실제비밀번호@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   - 이 전체 문자열을 메모장에 잠깐 복사해두세요 (3단계에서 씁니다)

---

## 3단계. Render에 배포하기 (10분)
1. https://render.com 접속 → **GitHub 계정으로 가입** (1단계에서 만든 계정으로 로그인하면 편해요)
2. 대시보드에서 **New +** → **Web Service** 클릭
3. 1단계에서 만든 `yoga-signup-app` 저장소를 선택 → **Connect**
4. 설정 화면에서:
   - **Name**: 원하는 이름 (예: `yoga-signup`)
   - **Region**: Singapore (한국과 가장 가까움)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free** 선택
5. 아래 **Environment Variables** 항목에서 **Add Environment Variable** 클릭
   - Key: `MONGODB_URI`
   - Value: 2단계에서 복사해둔 연결 문자열 붙여넣기
6. **Create Web Service** 클릭 → 2~5분 정도 빌드/배포가 진행돼요
7. 완료되면 화면 상단에 `https://yoga-signup-xxxx.onrender.com` 같은 주소가 생겨요. 이 주소를 클릭해서 앱이 뜨는지 확인하세요.

---

## 4단계. 앱 최초 설정
1. 방금 생긴 주소로 접속 → **관리자 로그인** → 처음이니 PIN을 새로 설정
2. **격주 금요일 설정**에서 기준 금요일 지정
3. **+ 다음 수업일 추가**로 이번 주 월/수/금 세션 등록
4. 이 주소를 요가동호회 카톡방에 공지로 올리면 끝!

---

## 꼭 알아두셔야 할 것
- **첫 접속이 느릴 수 있어요**: Render 무료 플랜은 15분 동안 아무도 안 들어오면 서버가 잠들어요. 그 상태에서 첫 번째로 링크를 누르는 사람은 30~60초 정도 로딩 화면을 보게 됩니다. 그 다음부터는 빨라져요. (매일 아침 9시 신청 타이밍에 맞춰 누군가 미리 한 번 열어두면 이 지연을 피할 수 있어요.)
- **데이터는 이제 안전해요**: 신청자 명단은 MongoDB Atlas에 저장되기 때문에, Render 서버가 잠들었다 깨어나도 사라지지 않습니다.
- **관리자 PIN을 잊어버리면**: MongoDB Atlas 사이트에서 `appdata` 컬렉션의 `config` 문서를 열어 `adminPinHash` 값을 지우고 저장하면, 앱에서 다시 처음 설정 화면으로 돌아갑니다. (이 부분은 조작이 조금 까다로우니 필요하면 저한테 다시 물어보셔도 돼요.)
- **완전 무료 유지 조건**: Render Free, MongoDB Atlas M0(Free) 모두 신용카드 없이 영구 무료로 쓸 수 있는 플랜이에요. 다만 Render는 매달 750시간까지 무료 실행 시간을 주는데, 이 규모(28명, 하루 몇 번 접속)면 절대 초과하지 않아요.

## 로컬에서 먼저 테스트해보고 싶다면
```bash
npm install
npm start
```
`MONGODB_URI` 환경변수를 설정하지 않으면 자동으로 로컬 파일(`data/` 폴더)에 저장하는 개발 모드로 동작해서, Atlas 없이도 기능을 미리 확인할 수 있어요.
