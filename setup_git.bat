@echo off
cd C:\finbot
"C:\Program Files\Git\bin\git.exe" config --global user.email faviomendoza27jl@gmail.com
"C:\Program Files\Git\bin\git.exe" config --global user.name "Favio Mendoza"
"C:\Program Files\Git\bin\git.exe" init > C:\finbot\git_out.txt 2>&1
"C:\Program Files\Git\bin\git.exe" add . >> C:\finbot\git_out.txt 2>&1
"C:\Program Files\Git\bin\git.exe" commit -m "Initial commit - FinBot Peru MVP Fase 1+2" >> C:\finbot\git_out.txt 2>&1